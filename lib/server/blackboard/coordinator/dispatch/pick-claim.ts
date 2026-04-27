// HARDENING_PLAN.md#C4 — tickCoordinator decomposition phase 1.
//
// pickClaim — select an open todo and an idle session, then transition
// the todo open → claimed → in-progress via SQL CAS. Returns either:
//   - { kind: 'skip', outcome }    — early-exit with skipped/stale outcome
//   - { kind: 'picked', context }  — ClaimContext for the next phase
//
// The picker logic itself is dense:
//   - Filter out retry-exhausted opens (STATUS Run-health #5)
//   - Build session candidates (restrictToSessionID / excludeSessionIDs)
//   - For each candidate: skip-if-busy on board AND skip-if-in-flight,
//     except auto-abort zombies past zombieThreshold (memory: opencode
//     zombie messages can hang silently)
//   - Score open todos by stigmergy heat × role affinity, drop strict-role
//     mismatches, pick the highest non-overlapping result
//   - Compute file-hash anchors for the todo's expectedFiles before the
//     CAS so the commit-time drift check has its baseline
//
// All in-flight tokens of state for this work happen here; the next
// phases only read from ClaimContext.

import 'server-only';

import path from 'node:path';

import { getRun } from '../../../swarm-registry';
import {
  abortSessionServer,
  getSessionMessagesServer,
} from '../../../opencode-server';
import { roleNamesBySessionID } from '../../../../blackboard/roles';
import { listBoardItems, transitionStatus } from '../../store';
import { toFileHeat } from '../../../../opencode/transform';
import type { OpencodeMessage } from '../../../../opencode/types';
import type { BoardItem } from '../../../../blackboard/types';
import { scoreTodoByHeat } from '../heat';
import {
  oldestInFlightAgeMs,
  ownerIdForSession,
} from '../message-helpers';
import {
  extractPathTokens,
  pathOverlaps,
  sha7,
} from '../path-utils';
import { currentRetryCount, MAX_STALE_RETRIES } from '../retry';
import { zombieThresholdFor } from '../timeouts';
import type { TickOpts, TickOutcome } from '../types';
import type { ClaimContext } from './_context';

export type PickResult =
  | { kind: 'skip'; outcome: TickOutcome }
  | { kind: 'picked'; context: ClaimContext };

export async function pickClaim(
  swarmRunID: string,
  opts: TickOpts,
): Promise<PickResult> {
  const meta = await getRun(swarmRunID);
  if (!meta) return { kind: 'skip', outcome: { status: 'skipped', reason: 'run not found' } };
  if (meta.sessionIDs.length === 0) {
    return { kind: 'skip', outcome: { status: 'skipped', reason: 'run has no sessions' } };
  }

  const all = listBoardItems(swarmRunID);
  // STATUS Run-health #5 — exclude retry-exhausted opens from the picker
  // so a board full of "workers refused twice" items doesn't keep the
  // run "active" forever. Sessions go idle → ratchet fires → tier
  // escalation rephrases or drops them.
  const openTodos = all.filter(
    (i) =>
      i.status === 'open' &&
      (i.kind === 'todo' || i.kind === 'question' || i.kind === 'synthesize') &&
      currentRetryCount(i.note) < MAX_STALE_RETRIES,
  );
  if (openTodos.length === 0) {
    const retryStuck = all.filter(
      (i) =>
        i.status === 'open' &&
        (i.kind === 'todo' || i.kind === 'question' || i.kind === 'synthesize') &&
        currentRetryCount(i.note) >= MAX_STALE_RETRIES,
    ).length;
    return {
      kind: 'skip',
      outcome: {
        status: 'skipped',
        reason:
          retryStuck > 0
            ? `no claimable todos (${retryStuck} retry-exhausted excluded)`
            : 'no open todos',
      },
    };
  }

  // Session picker: skip any session that owns a claimed/in-progress item
  // (coordinator-visible busy state) or has an in-flight assistant turn
  // (opencode-visible busy state). First idle wins. When restrictToSessionID
  // is set, only that session is considered — enables per-session fan-out
  // from the auto-ticker without requiring a second picker code path.
  const excluded = new Set(opts.excludeSessionIDs ?? []);
  const sessionCandidates = opts.restrictToSessionID
    ? meta.sessionIDs.includes(opts.restrictToSessionID) &&
      !excluded.has(opts.restrictToSessionID)
      ? [opts.restrictToSessionID]
      : []
    : meta.sessionIDs.filter((sid) => !excluded.has(sid));
  const messagesByCandidate = new Map<string, OpencodeMessage[]>();
  let pickedSession: string | null = null;
  for (const sessionID of sessionCandidates) {
    const ownerId = ownerIdForSession(sessionID);
    const busyOnBoard = all.some(
      (i) =>
        i.ownerAgentId === ownerId &&
        (i.status === 'claimed' || i.status === 'in-progress'),
    );
    if (busyOnBoard) continue;
    const messages = await getSessionMessagesServer(sessionID, meta.workspace);
    messagesByCandidate.set(sessionID, messages);
    const inFlightAge = oldestInFlightAgeMs(messages);
    if (inFlightAge > 0) {
      const zombieThreshold = zombieThresholdFor(meta.pattern);
      if (inFlightAge < zombieThreshold) {
        // Real in-flight work — skip this session for now.
        continue;
      }
      // Zombie: in-flight > threshold. Auto-abort and proceed to dispatch.
      // Fire-and-forget abort so the picker doesn't stall on a slow abort.
      console.log(
        `[coordinator] session ${sessionID.slice(-8)}: zombie turn (${Math.round(inFlightAge / 60_000)}m in-flight) — auto-aborting and dispatching`,
      );
      abortSessionServer(sessionID, meta.workspace).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[coordinator] session ${sessionID.slice(-8)}: auto-abort failed:`,
          message,
        );
      });
    }
    if (!pickedSession) pickedSession = sessionID;
  }

  // Work picker: stigmergy v1 exploratory bias. Heat is derived from
  // every session's patch parts in the run. Role affinity (primary
  // sort) runs above heat: matching roles get -1, mismatches +1.
  const allMessages = [...messagesByCandidate.values()].flat();
  const heat = toFileHeat(allMessages);
  const heatWeightedPick = heat.length > 0;
  const sessionRole = pickedSession
    ? roleNamesBySessionID(meta).get(pickedSession)
    : undefined;

  // PATTERN_DESIGN/role-differentiated.md I4 — per-role token budgets.
  if (
    meta.roleBudgets &&
    sessionRole &&
    typeof meta.roleBudgets[sessionRole] === 'number'
  ) {
    const cap = meta.roleBudgets[sessionRole];
    const sidByRole = roleNamesBySessionID(meta);
    let spent = 0;
    for (const [sid, role] of sidByRole.entries()) {
      if (role !== sessionRole) continue;
      const msgs = messagesByCandidate.get(sid) ?? [];
      for (const m of msgs) {
        if (m.info.role !== 'assistant') continue;
        spent += m.info.tokens?.total ?? 0;
      }
    }
    if (spent >= cap) {
      console.log(
        `[coordinator] role-budget: ${sessionRole} hit ${spent}/${cap} tokens — denying claim (PATTERN_DESIGN/role-differentiated.md I4)`,
      );
      return {
        kind: 'skip',
        outcome: {
          status: 'skipped',
          reason: `role-budget: ${sessionRole} hit ${spent}/${cap} tokens`,
        },
      };
    }
  }

  const scored = openTodos.map((t) => {
    let roleAffinity = 0;
    if (sessionRole && t.preferredRole) {
      roleAffinity = t.preferredRole === sessionRole ? -1 : 1;
    }
    return {
      todo: t,
      roleAffinity,
      score: heatWeightedPick ? scoreTodoByHeat(t.content, heat, pickedSession ?? undefined) : 0,
    };
  });

  // PATTERN_DESIGN/role-differentiated.md I1 — strict role routing.
  if (meta.strictRoleRouting && sessionRole) {
    const before = scored.length;
    const kept = scored.filter(
      (s) => !s.todo.preferredRole || s.todo.preferredRole === sessionRole,
    );
    if (kept.length === 0 && before > 0) {
      console.log(
        `[coordinator] strict-role: session ${pickedSession?.slice(-8)} role=${sessionRole} has no matching todos (${before} candidates filtered) — skipping (PATTERN_DESIGN/role-differentiated.md I1)`,
      );
      return {
        kind: 'skip',
        outcome: {
          status: 'skipped',
          reason: `strict-role: no matches for session role '${sessionRole}'`,
        },
      };
    }
    if (kept.length < before) {
      console.log(
        `[coordinator] strict-role: filtered ${before - kept.length} non-matching todos for session role=${sessionRole}`,
      );
    }
    scored.length = 0;
    scored.push(...kept);
  }
  scored.sort((a, b) => {
    if (a.roleAffinity !== b.roleAffinity) return a.roleAffinity - b.roleAffinity;
    if (a.score !== b.score) return a.score - b.score;
    return a.todo.createdAtMs - b.todo.createdAtMs;
  });

  // Overlap avoidance: prefer todos whose parsed file/dir tokens
  // don't collide with any currently in-progress item's tokens.
  const inProgressTokens = all
    .filter((i) => i.status === 'in-progress' || i.status === 'claimed')
    .map((i) => extractPathTokens(i.content));
  const nonOverlap = scored.filter((s) => {
    if (inProgressTokens.length === 0) return true;
    const tokens = extractPathTokens(s.todo.content);
    if (tokens.size === 0) return true;
    return !inProgressTokens.some((other) => pathOverlaps(tokens, other));
  });
  const finalQueue = nonOverlap.length > 0 ? nonOverlap : scored;
  if (nonOverlap.length === 0 && inProgressTokens.length > 0 && scored.length > 0) {
    console.log(
      `[coordinator] all open todos overlap in-progress work — picking heat-top anyway`,
    );
  } else if (nonOverlap.length < scored.length) {
    console.log(
      `[coordinator] skipped ${scored.length - nonOverlap.length} todo(s) to avoid in-progress overlap`,
    );
  }
  const todo = finalQueue[0].todo;

  // PATTERN_DESIGN/stigmergy.md heat-picked-timeline-chip — flag this
  // claim with `pickedByHeat: true` when stigmergy actually shifted the
  // order.
  let pickedByHeat = false;
  if (heatWeightedPick && finalQueue.length > 1) {
    const ageOnlyFirst = [...finalQueue]
      .map((s) => s.todo)
      .sort((a, b) => a.createdAtMs - b.createdAtMs)[0];
    pickedByHeat = ageOnlyFirst.id !== todo.id;
  }
  if (pickedByHeat) {
    console.log(
      `[coordinator] heat-weighted pick: "${todo.content.slice(0, 50)}..." (score=${scored[0].score}, max=${scored[scored.length - 1].score})`,
    );
  }
  if (sessionRole && todo.preferredRole && todo.preferredRole === sessionRole) {
    console.log(
      `[coordinator] role-match pick: role=${sessionRole} claimed "${todo.content.slice(0, 50)}..."`,
    );
  }

  if (!pickedSession) {
    return {
      kind: 'skip',
      outcome: {
        status: 'skipped',
        reason: opts.restrictToSessionID
          ? `session ${opts.restrictToSessionID.slice(-8)} busy or unknown`
          : 'no idle sessions',
      },
    };
  }

  const sessionID = pickedSession;
  const ownerAgentId = ownerIdForSession(sessionID);

  // Claim-time hash anchoring (2026-04-24 declared-roles alignment).
  // SHA anchors the planner-declared expectedFiles BEFORE transitioning
  // to 'claimed' so runGateChecks's drift check has its baseline.
  // HARDENING_PLAN.md#E5 — parallelize sha7 reads.
  let claimAnchors: { path: string; sha: string }[] | null = null;
  if (todo.expectedFiles && todo.expectedFiles.length > 0) {
    claimAnchors = await Promise.all(
      todo.expectedFiles.map(async (rel) => {
        const abs = path.resolve(meta.workspace, rel);
        try {
          return { path: rel, sha: await sha7(abs) };
        } catch {
          // File absent at claim time — sentinel '' anchors "expected
          // to be created." Drift check distinguishes this from a live hash.
          return { path: rel, sha: '' };
        }
      }),
    );
  }

  // CAS: open → claimed → in-progress.
  const claim = transitionStatus(swarmRunID, todo.id, {
    from: 'open',
    to: 'claimed',
    ownerAgentId,
    fileHashes: claimAnchors,
    pickedByHeat: pickedByHeat || undefined,
  });
  if (!claim.ok) {
    return {
      kind: 'skip',
      outcome: { status: 'skipped', reason: `claim lost race: ${claim.currentStatus}` },
    };
  }

  const start = transitionStatus(swarmRunID, todo.id, {
    from: 'claimed',
    to: 'in-progress',
  });
  if (!start.ok) {
    return {
      kind: 'skip',
      outcome: { status: 'skipped', reason: `start lost race: ${start.currentStatus}` },
    };
  }

  return {
    kind: 'picked',
    context: {
      meta,
      sessionID,
      todo: todo as BoardItem,
      ownerAgentId,
      claimAnchors,
      pickedByHeat,
    },
  };
}
