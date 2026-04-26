// Coordinator tick — steps 3b (idle detection) + 3c (claim + work + commit)
// of SWARM_PATTERNS.md §1.
//
// One tick:
//   1. Pick an open todo and an idle session that has nothing in-flight on
//      the board. If either is missing, return a reason and exit.
//   2. Open → claimed → in-progress directly via the store (bypass HTTP
//      action route; the coordinator runs server-side with a trusted caller).
//   3. Send a work prompt to the session.
//   4. Poll /message until the assistant turn completes or the timeout fires.
//   5. Extract edited file paths from the new turn's `patch` parts, hash
//      them, and transition in-progress → done with those hashes attached.
//      On error/timeout, transition to stale with a note.
//
// Concurrency model: concurrent calls are safe IFF each call targets a
// distinct session via opts.restrictToSessionID. The auto-ticker uses this
// to fan out per-session tickers for parallelism (SWARM_PATTERNS.md §1
// Open questions → Blackboard parallelism). CAS at the SQL layer protects
// against two sessions racing on the same todo (the loser gets `skipped:
// claim lost race`). Calls without restrictToSessionID still use the
// "first idle session wins" picker and should NOT overlap — the map-reduce
// synthesis loop relies on that.
//
// Server-only. Never imported from client code. Extracted from
// coordinator.ts in #107 phase 5.

import path from 'node:path';

import { getRun } from '../../swarm-registry';
import {
  abortSessionServer,
  getSessionMessagesServer,
  postSessionMessageServer,
} from '../../opencode-server';
import { opencodeAgentForSession, roleNamesBySessionID } from '../../../blackboard/roles';
import { reviewWorkerDiff } from '../critic';
import { verifyWorkerOutcome } from '../verifier';
import { listBoardItems, transitionStatus } from '../store';
import { toFileHeat } from '../../../opencode/transform';
import type { OpencodeMessage } from '../../../opencode/types';
import { scheduleCasDriftReplan } from './drift';
import { scoreTodoByHeat } from './heat';
import {
  buildWorkPrompt,
  extractLatestErrorText,
  oldestInFlightAgeMs,
  ownerIdForSession,
} from './message-helpers';
import {
  extractEditedPaths,
  extractPathTokens,
  extractWorkerAssistantText,
  pathOverlaps,
  relativizeToWorkspace,
  sha7,
} from './path-utils';
import {
  currentRetryCount,
  MAX_STALE_RETRIES,
  retryOrStale,
} from './retry';
import { turnTimeoutFor, zombieThresholdFor } from './timeouts';
import type { TickOpts, TickOutcome } from './types';
import { waitForSessionIdle } from './wait';

export async function tickCoordinator(
  swarmRunID: string,
  opts: TickOpts = {},
): Promise<TickOutcome> {
  const meta = await getRun(swarmRunID);
  if (!meta) return { status: 'skipped', reason: 'run not found' };
  if (meta.sessionIDs.length === 0) {
    return { status: 'skipped', reason: 'run has no sessions' };
  }

  const all = listBoardItems(swarmRunID);
  // STATUS Run-health #5 — exclude retry-exhausted opens from the picker
  // so a board full of "workers refused twice" items doesn't keep the
  // run "active" forever. Sessions go idle → ratchet fires → tier
  // escalation rephrases or drops them. Mirrors the predicate the
  // periodic-sweep path (auto-ticker.ts ~L1252) already uses for the
  // ambition-ratchet drained-board check; before this fix the standard
  // auto-idle path saw these as active work and the ratchet stayed
  // dormant indefinitely (run_mob31bx6_jzdfs2 stranded at 22.33M with
  // every open item at [retry:2]).
  const openTodos = all.filter(
    (i) =>
      i.status === 'open' &&
      (i.kind === 'todo' || i.kind === 'question' || i.kind === 'synthesize') &&
      currentRetryCount(i.note) < MAX_STALE_RETRIES,
  );
  if (openTodos.length === 0) {
    // Distinguish "no opens" from "only retry-exhausted opens" so the
    // dev console shows what's happening when the run is gated on a
    // re-plan rather than truly drained.
    const retryStuck = all.filter(
      (i) =>
        i.status === 'open' &&
        (i.kind === 'todo' || i.kind === 'question' || i.kind === 'synthesize') &&
        currentRetryCount(i.note) >= MAX_STALE_RETRIES,
    ).length;
    return {
      status: 'skipped',
      reason:
        retryStuck > 0
          ? `no claimable todos (${retryStuck} retry-exhausted excluded)`
          : 'no open todos',
    };
  }

  // Session picker: skip any session that owns a claimed/in-progress item
  // (coordinator-visible busy state) or has an in-flight assistant turn
  // (opencode-visible busy state). First idle wins. When restrictToSessionID
  // is set, only that session is considered — enables per-session fan-out
  // from the auto-ticker without requiring a second picker code path.
  //
  // We fetch every candidate session's messages here both for the busy
  // check and to feed toFileHeat for the stigmergy-weighted todo picker
  // below. Fetching once per tick keeps the fan-out cost linear in
  // sessionIDs.
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
      // See memory/reference_opencode_zombie_messages.md — opencode turns
      // can hang without completed/error flags, silently blocking dispatch.
      // Fire-and-forget abort so the picker doesn't stall on a slow abort;
      // the next turn's post (postSessionMessageServer below) will wait for
      // the server to accept it regardless.
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

  // Work picker: stigmergy v1 exploratory bias. Score open todos by
  // heat-summed file matches in their content (see scoreTodoByHeat).
  // Ascending sort means low-heat (unexplored) todos get picked first;
  // ties break on oldest createdAtMs (preserves the pre-stigmergy
  // "oldest first" behavior when heat can't differentiate).
  //
  // Heat is derived from every session's patch parts in the run. At
  // v0 (observation-only) it was computed client-side; at v1 we also
  // need it server-side here. We already fetched the busy-check
  // messages above, so the only incremental cost is the merge.
  //
  // Role affinity (primary sort) runs above heat: if the picked
  // session has a pinned role (role-differentiated pattern) and an
  // item carries a matching preferredRole, the match gets -1 (highest
  // priority). A mismatch gets +1 (de-prioritized but still claimable
  // — soft bias, not hard routing). Neutral items (either side
  // unset) get 0 so the heat bias still decides order among them.
  const allMessages = [...messagesByCandidate.values()].flat();
  const heat = toFileHeat(allMessages);
  const heatWeightedPick = heat.length > 0;
  const sessionRole = pickedSession
    ? roleNamesBySessionID(meta).get(pickedSession)
    : undefined;

  // PATTERN_DESIGN/role-differentiated.md I4 — per-role token budgets.
  // Soft cutoff: when meta.roleBudgets[<role>] is set AND the picked
  // session's role has accumulated tokens at or above the ceiling,
  // refuse to dispatch new work to that session. Already-claimed items
  // run to completion; we only block FUTURE claims.
  // Tokens are summed across the session(s) holding the role from
  // assistant messages already loaded in messagesByCandidate (no
  // extra fetch). For role-differentiated this is one session per
  // role; the loop generalises if other patterns ever opt in.
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
        status: 'skipped',
        reason: `role-budget: ${sessionRole} hit ${spent}/${cap} tokens`,
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
  // When meta.strictRoleRouting is set AND the picked session has a
  // role, drop items with a non-matching preferredRole from the
  // candidate list. Items without a preferredRole stay claimable
  // (no role declared, any session can take). Items with matching
  // role stay. Mismatch = drop. If filtering empties the queue, the
  // session is effectively idle for this tick — they'll wait for a
  // matching item to land or another session to claim from a
  // different role.
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
        status: 'skipped',
        reason: `strict-role: no matches for session role '${sessionRole}'`,
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
  // don't collide with any currently in-progress item's tokens. If
  // every candidate overlaps, fall back to the heat-weighted top
  // (can't deadlock — something has to move). Only kicks in when
  // at least one candidate is non-overlapping, so runs with
  // abstract todos (no paths in content) still pick normally.
  const inProgressTokens = all
    .filter((i) => i.status === 'in-progress' || i.status === 'claimed')
    .map((i) => extractPathTokens(i.content));
  const nonOverlap = scored.filter((s) => {
    if (inProgressTokens.length === 0) return true;
    const tokens = extractPathTokens(s.todo.content);
    if (tokens.size === 0) return true; // abstract todo — no overlap to measure
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
  // order. Detected by checking that (a) heat scoring was active AND
  // (b) the picked item differs from what age-only ordering would have
  // chosen. The age-only first pick is the open todo with the earliest
  // createdAtMs, so we compare that against `todo`.
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
    // Role match diagnostic — only when the matched item wasn't the
    // natural first pick anyway (heat + age alone). Quiet signal that
    // role routing actually did work, useful on role-differentiated
    // runs where we want to verify the bias fires.
    console.log(
      `[coordinator] role-match pick: role=${sessionRole} claimed "${todo.content.slice(0, 50)}..."`,
    );
  }

  if (!pickedSession) {
    return {
      status: 'skipped',
      reason: opts.restrictToSessionID
        ? `session ${opts.restrictToSessionID.slice(-8)} busy or unknown`
        : 'no idle sessions',
    };
  }

  const sessionID = pickedSession;
  const ownerAgentId = ownerIdForSession(sessionID);

  // Claim-time hash anchoring (2026-04-24 declared-roles alignment).
  // When the planner declared expectedFiles on the todo, read and SHA
  // each file BEFORE transitioning to 'claimed'. These anchors power
  // the commit-time drift check: if a file's hash changed between
  // claim and commit AND the file wasn't in this worker's edited
  // paths, another worker modified it under us → reject with stale
  // (CAS fail). An empty sha sentinel means the file didn't exist at
  // claim time — worker is expected to create it; drift is detected
  // if someone else created it concurrently.
  //
  // Todos without expectedFiles get fileHashes: null (pre-Stage-1
  // behavior) — no CAS anchor, commit-time hashes recorded from
  // editedPaths only.
  let claimAnchors: { path: string; sha: string }[] | null = null;
  if (todo.expectedFiles && todo.expectedFiles.length > 0) {
    claimAnchors = [];
    for (const rel of todo.expectedFiles) {
      const abs = path.resolve(meta.workspace, rel);
      try {
        claimAnchors.push({ path: rel, sha: await sha7(abs) });
      } catch {
        // File absent at claim time — sentinel '' anchors "expected to
        // be created." Drift check distinguishes this from a live hash.
        claimAnchors.push({ path: rel, sha: '' });
      }
    }
  }

  // Claim. CAS protects against another coordinator / external caller
  // racing us to the same 'open' item.
  const claim = transitionStatus(swarmRunID, todo.id, {
    from: 'open',
    to: 'claimed',
    ownerAgentId,
    fileHashes: claimAnchors,
    pickedByHeat: pickedByHeat || undefined,
  });
  if (!claim.ok) {
    return { status: 'skipped', reason: `claim lost race: ${claim.currentStatus}` };
  }

  const start = transitionStatus(swarmRunID, todo.id, {
    from: 'claimed',
    to: 'in-progress',
  });
  if (!start.ok) {
    return { status: 'skipped', reason: `start lost race: ${start.currentStatus}` };
  }

  // Snapshot existing messages so we can diff "new since work-prompt".
  const before = await getSessionMessagesServer(sessionID, meta.workspace);
  const knownIDs = new Set(before.map((m) => m.info.id));

  const prompt = buildWorkPrompt(todo);
  // Pattern-aware opencode agent-config routing for the worker's prompt.
  // Hierarchical patterns (orchestrator-worker, role-differentiated,
  // debate-judge, critic-loop) map session → role → opencode agent-config
  // name from opencode.json. Blackboard's planner/worker labels are
  // display-only (2026-04-24 stance revision) — opencodeAgentForSession
  // returns undefined for it so we don't force users to define synthetic
  // `planner` / `worker-<N>` agents in their opencode.json.
  const dispatchAgent = opencodeAgentForSession(meta, sessionID);
  // Team-model pinning: when the new-run-modal team picker produced a
  // per-session model list, look up this session's pinned model by
  // index and pass it through. opencode's prompt endpoint accepts
  // `model` as a direct model ID (e.g. "ollama/glm-5.1:cloud"); the
  // agent field (from role tagging above) wins when both are set,
  // which is the intended precedence for role-differentiated runs.
  // See SwarmRunRequest.teamModels for the contract.
  const sessionIdx = meta.sessionIDs.indexOf(sessionID);
  // PATTERN_DESIGN/map-reduce.md I4 — synthesize items run on the
  // run's pinned `synthesisModel` regardless of which session
  // claims. This keeps synthesis quality consistent run-to-run
  // (the pinned model is typically chosen for reasoning + summary
  // strength). Falls back to per-session pinning when the run
  // didn't opt into synthesis-pinning.
  const pinnedModel =
    todo.kind === 'synthesize' && meta.synthesisModel
      ? meta.synthesisModel
      : sessionIdx >= 0
        ? meta.teamModels?.[sessionIdx]
        : undefined;
  try {
    await postSessionMessageServer(sessionID, meta.workspace, prompt, {
      agent: dispatchAgent,
      model: pinnedModel,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const outcome = retryOrStale(swarmRunID, todo, `prompt-send failed: ${message.slice(0, 160)}`);
    return { status: 'stale', sessionID, itemID: todo.id, reason: `${outcome}: ${message}` };
  }

  const timeoutMs = opts.timeoutMs ?? turnTimeoutFor(meta.pattern);
  const deadline = Date.now() + timeoutMs;
  const waited = await waitForSessionIdle(
    sessionID,
    meta.workspace,
    knownIDs,
    deadline,
  );

  if (!waited.ok) {
    let reason =
      waited.reason === 'timeout'
        ? 'turn timed out'
        : waited.reason === 'silent'
          ? 'turn went silent'
          : waited.reason === 'provider-unavailable'
            ? 'provider-unavailable'
            : waited.reason === 'tool-loop'
              ? 'tool-loop'
              : 'turn errored';
    // #96 — for the generic 'error' branch, re-fetch the session and
    // extract the actual provider-level error string so the stale-note
    // (and the operator-visible board) carries something more useful
    // than 'turn errored'. This is the path that bit role-differentiated
    // in the MAXTEAM-2026-04-26 stress test: status=error, no log line
    // explaining what went wrong. Now the reason field carries
    // "turn errored: <opencode info.error excerpt>".
    if (waited.reason === 'error') {
      try {
        const after = await getSessionMessagesServer(sessionID, meta.workspace);
        const errorText = extractLatestErrorText(after, knownIDs);
        if (errorText) {
          reason = `turn errored: ${errorText.slice(0, 160)}`;
        }
      } catch {
        // Best-effort enrichment — fall through with the generic reason.
      }
    }
    // On timeout, abort the opencode turn eagerly. Without this the turn
    // keeps consuming tokens in the background for up to
    // ZOMBIE_TURN_THRESHOLD_MS (10 min) before the picker catches it on
    // its next pass. 'errored' skips the abort — opencode already surfaced
    // a terminal signal, so there's nothing in flight to cancel. 'silent'
    // already aborted inside waitForSessionIdle (F1 watchdog), so no
    // double-abort is needed. Same fire-and-forget pattern as the zombie-
    // picker abort above.
    if (waited.reason === 'timeout') {
      console.log(
        `[coordinator] session ${sessionID.slice(-8)}: worker timeout after ${Math.round(timeoutMs / 60_000)}m on ${todo.id} — aborting turn`,
      );
      abortSessionServer(sessionID, meta.workspace).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[coordinator] session ${sessionID.slice(-8)}: timeout-abort failed:`,
          message,
        );
      });
    }
    const outcome = retryOrStale(swarmRunID, todo, reason);
    return { status: 'stale', sessionID, itemID: todo.id, reason: `${outcome}: ${reason}` };
  }

  const rawEditedPaths = extractEditedPaths(waited.messages, waited.newIDs);
  const editedPaths = rawEditedPaths.map((p) =>
    relativizeToWorkspace(meta.workspace, p),
  );

  // Commit-time CAS drift check (2026-04-24 declared-roles alignment).
  // For every file the planner pre-announced on the todo (claimAnchors,
  // persisted in fileHashes at claim time), re-hash it now and compare
  // against the claim-time anchor. A mismatch means the file moved
  // under this worker — UNLESS the file is in this worker's editedPaths,
  // in which case the change is the worker's own legitimate edit and
  // doesn't count as drift. Any drift → stale (CAS fail), skip critic
  // + verifier gates entirely. Matches the "1. Re-hash claimed files
  // → reject if any changed" step of the ollama-swarm blackboard spec.
  if (todo.expectedFiles && todo.expectedFiles.length > 0 && todo.fileHashes) {
    const editedSet = new Set(editedPaths);
    const driftedPaths: string[] = [];
    for (const anchor of todo.fileHashes) {
      if (editedSet.has(anchor.path)) continue; // legitimate self-edit
      const abs = path.resolve(meta.workspace, anchor.path);
      let currentSha = '';
      try {
        currentSha = await sha7(abs);
      } catch {
        // File absent now — drift if it existed at claim time.
        currentSha = '';
      }
      if (currentSha !== anchor.sha) {
        driftedPaths.push(anchor.path);
      }
    }
    if (driftedPaths.length > 0) {
      const driftedDeltas = await Promise.all(
        driftedPaths.map(async (p) => {
          const anchor = todo.fileHashes?.find((a) => a.path === p);
          const currentSha = await sha7(path.resolve(meta.workspace, p)).catch(() => 'none');
          return `${p} (${anchor?.sha ?? 'none'} → ${currentSha})`;
        }),
      );
      const detail = driftedDeltas.join('\n').trim();
      const note = `[cas-drift:${detail}]`;
      console.log(
        `[coordinator] ${swarmRunID}/${todo.id}: CAS drift on ${driftedPaths.length} file(s):\n${detail} — moving to stale before critic`,
      );
      const rolled = transitionStatus(swarmRunID, todo.id, {
        from: 'in-progress',
        to: 'stale',
        note: note.slice(0, 200),
        staleSinceSha: driftedPaths[0],
      });
      if (rolled.ok) {
        // PATTERN_DESIGN/blackboard.md I1 — auto-replan on CAS drift.
        // Fire-and-forget a focused planner sweep so a replacement
        // todo lands in seconds rather than waiting for the next
        // periodic sweep (often minutes away). Throttled by
        // CAS_REPLAN_MIN_INTERVAL_MS to avoid thrash when N concurrent
        // workers all hit drift on adjacent files.
        void scheduleCasDriftReplan(swarmRunID, driftedPaths);
        return {
          status: 'stale',
          sessionID,
          itemID: todo.id,
          reason: `cas-drift: ${detail}`,
        };
      }
      // CAS rollback lost race (another agent moved the item) — fall
      // through to the normal done path; the other transition wins.
    }
  }

  // Hash whatever was edited. A turn that produced no edits (skip: / text
  // answer / q-reply) still commits to done — the todo was addressed, just
  // without a patch. That's a legitimate outcome for questions or no-op
  // todos and the board reflects it as `done` with empty fileHashes.
  //
  // `rel` here may be relative (the common case — an in-workspace edit) or
  // absolute (out-of-tree edit, already normalized to forward slashes).
  // path.resolve handles both: an absolute arg wins over the base.
  const fileHashes: { path: string; sha: string }[] = [];
  for (const rel of editedPaths) {
    try {
      fileHashes.push({
        path: rel,
        sha: await sha7(path.resolve(meta.workspace, rel)),
      });
    } catch {
      // Edited then deleted, or path outside workspace (resolve() out-of-tree).
      // Skip — commit-time drift isn't what we're modeling here anyway.
    }
  }

  // #7.Q42 — phantom-completion guard. The legitimate "no-edit done" cases
  // are: (a) a worker explicitly replies with "skip: <reason>" because the
  // todo was wrong / already done, OR (b) a worker did real research-only
  // tool calls (read/grep/glob) on a survey-shape todo that needs no edits.
  // Both shapes leave editedPaths empty. The PHANTOM case — discovered on
  // run_mog101p0_7js6lt 2026-04-26 — is a worker that emits text-only
  // responses containing pseudo-tool-call markup like
  // `<tool>glob<arg_key>...</arg_value></tool|>` as plain text, makes ZERO
  // real tool calls, never edits anything, but the assistant text is non-
  // empty so the dispatcher trusted it as a completed turn → 9 phantom
  // "done" todos with no real artifacts.
  //
  // Reject this case: if the worker's new turns contain ZERO real tool
  // parts AND ZERO patch parts AND the text doesn't begin with "skip:",
  // bounce to stale. Legitimate research work passes (real tool parts);
  // legitimate skip replies pass (skip: prefix); only the
  // pseudo-tool-text class fails the guard.
  if (editedPaths.length === 0) {
    let realToolPartCount = 0;
    let realPatchPartCount = 0;
    for (const m of waited.messages) {
      if (!waited.newIDs.has(m.info.id)) continue;
      if (m.info.role !== 'assistant') continue;
      for (const p of m.parts) {
        if (p.type === 'tool') realToolPartCount += 1;
        if (p.type === 'patch') realPatchPartCount += 1;
      }
    }
    if (realToolPartCount === 0 && realPatchPartCount === 0) {
      const workerText = extractWorkerAssistantText(
        waited.messages,
        waited.newIDs,
      );
      const looksLikeSkip = /^\s*skip\s*:/i.test(workerText);
      if (!looksLikeSkip) {
        const note = '[phantom-no-tools] worker produced text-only response with zero real tool/patch parts and no skip: prefix';
        console.warn(
          `[coordinator] ${swarmRunID}/${todo.id}: ${note} (text=${workerText.length} chars)`,
        );
        const outcome = retryOrStale(swarmRunID, todo, note);
        return {
          status: 'stale',
          sessionID,
          itemID: todo.id,
          reason: `${outcome}: phantom-no-tools`,
        };
      }
    }
  }

  // Anti-busywork critic gate (opt-in via meta.enableCriticGate). Runs
  // between "turn completed" and "mark done" so a busywork verdict keeps
  // the item reclaim-able via retry-stale instead of shipping a green
  // checkmark for garbage work. Fail-open: any critic malfunction (spawn
  // failed at run creation, timeout, unparseable reply) falls through to
  // the normal done transition. See lib/server/blackboard/critic.ts.
  if (meta.enableCriticGate && meta.criticSessionID) {
    const workerText = extractWorkerAssistantText(
      waited.messages,
      waited.newIDs,
    );
    const review = await reviewWorkerDiff({
      swarmRunID,
      criticSessionID: meta.criticSessionID,
      workspace: meta.workspace,
      directive: meta.directive,
      todo,
      editedPaths,
      workerAssistantText: workerText,
      criticModel: meta.criticModel,
    });
    if (review.verdict === 'busywork') {
      const rejected = transitionStatus(swarmRunID, todo.id, {
        from: 'in-progress',
        to: 'stale',
        note: `[critic-rejected] ${review.reason}`.slice(0, 200),
      });
      // If the CAS lost (someone else moved it), just fall through to the
      // normal done-transition attempt below — no bulk rollback paths to
      // coordinate. This matches how the rest of the coordinator handles
      // mid-flight state changes.
      if (rejected.ok) {
        return {
          status: 'stale',
          sessionID,
          itemID: todo.id,
          reason: `critic-rejected: ${review.reason}`,
        };
      }
    }
    // 'substantive' or 'unclear' → fall through to the done transition.
    // 'unclear' is fail-open by design: critic malfunctions shouldn't
    // block progress. The rawReply (if any) is logged for post-hoc
    // review via the worker's session + this log line.
    if (review.verdict === 'unclear') {
      console.log(
        `[coordinator] ${swarmRunID}/${todo.id}: critic returned 'unclear' (${review.reason}) — failing open`,
      );
    }
  }

  // Playwright grounding (opt-in via meta.enableVerifierGate + per-todo
  // requiresVerification). Runs AFTER the critic gate approves, BEFORE
  // the done transition. Same fail-open posture as critic — any verifier
  // malfunction drops through to done. Only applies to items the planner
  // flagged as claiming a user-observable outcome; others skip straight
  // to done. See lib/server/blackboard/verifier.ts.
  if (
    todo.requiresVerification &&
    meta.enableVerifierGate &&
    meta.verifierSessionID &&
    meta.workspaceDevUrl
  ) {
    const workerText = extractWorkerAssistantText(
      waited.messages,
      waited.newIDs,
    );
    const v = await verifyWorkerOutcome({
      swarmRunID,
      verifierSessionID: meta.verifierSessionID,
      workspace: meta.workspace,
      workspaceDevUrl: meta.workspaceDevUrl,
      directive: meta.directive,
      todo,
      workerAssistantText: workerText,
      verifierModel: meta.verifierModel,
    });
    if (v.verdict === 'not-verified') {
      const rejected = transitionStatus(swarmRunID, todo.id, {
        from: 'in-progress',
        to: 'stale',
        note: `[verifier-rejected] ${v.reason}`.slice(0, 200),
      });
      if (rejected.ok) {
        return {
          status: 'stale',
          sessionID,
          itemID: todo.id,
          reason: `verifier-rejected: ${v.reason}`,
        };
      }
    }
    if (v.verdict === 'unclear') {
      console.log(
        `[coordinator] ${swarmRunID}/${todo.id}: verifier returned 'unclear' (${v.reason}) — failing open`,
      );
    }
  }

  const done = transitionStatus(swarmRunID, todo.id, {
    from: 'in-progress',
    to: 'done',
    fileHashes: fileHashes.length > 0 ? fileHashes : null,
    setCompletedAt: true,
  });
  if (!done.ok) {
    // Something else moved it mid-flight. Surface the observed state so the
    // caller can re-read and decide.
    return {
      status: 'stale',
      sessionID,
      itemID: todo.id,
      reason: `done-transition lost: ${done.currentStatus}`,
    };
  }

  return { status: 'picked', sessionID, itemID: todo.id, editedPaths };
}
