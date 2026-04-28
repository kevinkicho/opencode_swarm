//
// runGateChecks — between "turn completed" and "mark done", run four
// gates in order. Any rejection bounces the item to stale; pass-through
// hands the AwaitedContext forward extended with computed fileHashes.
//
// Gates (each can early-return stale):
//   1. CAS-drift — re-hash claim-anchored expectedFiles, fail if any
//      moved under us (another worker wrote the file). Skip files in
//      this worker's editedPaths (legitimate self-edits). Schedules a
//      focused replan on drift so a replacement todo lands quickly.
//   2. phantom-no-tools (Q42) — if the worker emitted text-only with
//      zero real tool/patch parts AND no "skip:" prefix, bounce. This
//      is the pseudo-tool-text class (worker emits `<tool>...</tool>`
//      as plain text without making real tool calls).
//   3. critic gate (opt-in via meta.enableCriticGate) — anti-busywork
//      review; busywork verdict bounces, unclear/substantive proceed.
//      Fail-open on critic malfunction.
//   4. verifier gate (opt-in via meta.enableVerifierGate +
//      todo.requiresVerification) — Playwright-grounded check that
//      the user-observable claim actually rendered. Same fail-open.
//
// Computes fileHashes for the worker's edited paths regardless of
// gate path so commitDone has them when gates fail-open and the
// item proceeds to done.

import 'server-only';

import path from 'node:path';

import { reviewWorkerDiff } from '../../critic';
import { verifyWorkerOutcome } from '../../verifier';
import { transitionStatus } from '../../store';
import { scheduleCasDriftReplan } from '../drift';
import {
  extractWorkerAssistantText,
  sha7,
} from '../path-utils';
import { retryOrStale } from '../retry';
import type { TickOutcome } from '../types';
import type { AwaitedContext, GatedContext } from './_context';

export type GateResult =
  | { kind: 'fail'; outcome: TickOutcome }
  | { kind: 'ok'; context: GatedContext };

export async function runGateChecks(
  awaited: AwaitedContext,
): Promise<GateResult> {
  const { meta, sessionID, todo, editedPaths, messages, newIDs } = awaited;

  // 1. CAS-drift check (2026-04-24 declared-roles alignment).
  // For every file the planner pre-announced on the todo, re-hash now
  // and compare against the claim-time anchor. A mismatch means the
  // file moved under us — UNLESS the file is in editedPaths, in
  // which case the change is the worker's own legitimate edit.
  if (todo.expectedFiles && todo.expectedFiles.length > 0 && todo.fileHashes) {
    const editedSet = new Set(editedPaths);
    const candidates = todo.fileHashes.filter((a) => !editedSet.has(a.path));
    const checked = await Promise.all(
      candidates.map(async (anchor) => {
        const abs = path.resolve(meta.workspace, anchor.path);
        let currentSha = '';
        try {
          currentSha = await sha7(abs);
        } catch {
          currentSha = '';
        }
        return { path: anchor.path, drifted: currentSha !== anchor.sha };
      }),
    );
    const driftedPaths = checked.filter((c) => c.drifted).map((c) => c.path);
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
        `[coordinator] ${meta.swarmRunID}/${todo.id}: CAS drift on ${driftedPaths.length} file(s):\n${detail} — moving to stale before critic`,
      );
      const rolled = transitionStatus(meta.swarmRunID, todo.id, {
        from: 'in-progress',
        to: 'stale',
        note: note.slice(0, 200),
        staleSinceSha: driftedPaths[0],
      });
      if (rolled.ok) {
        // Fire-and-forget a focused planner sweep so a replacement
        // todo lands in seconds rather than waiting for the next
        // periodic sweep.
        void scheduleCasDriftReplan(meta.swarmRunID, driftedPaths);
        return {
          kind: 'fail',
          outcome: {
            status: 'stale',
            sessionID,
            itemID: todo.id,
            reason: `cas-drift: ${detail}`,
          },
        };
      }
      // CAS rollback lost race — fall through to the normal done path.
    }
  }

  // Compute commit-time file hashes for whatever was edited. A turn
  // that produced no edits (skip / text answer / q-reply) still
  // commits to done — the todo was addressed without a patch.
  const fileHashes: { path: string; sha: string }[] = (
    await Promise.all(
      editedPaths.map(async (rel) => {
        try {
          return {
            path: rel,
            sha: await sha7(path.resolve(meta.workspace, rel)),
          };
        } catch {
          // Edited then deleted, or path outside workspace.
          return null;
        }
      }),
    )
  ).filter((x): x is { path: string; sha: string } => x !== null);

  // 2. #7.Q42 — phantom-completion guard. Reject text-only responses
  // that contain zero real tool/patch parts AND don't begin with
  // "skip:". The legitimate no-edit cases (skip + research-only) pass.
  //
  // **Synthesize items are exempt.** A `synthesize` todo is by
  // definition a "write a summary" task — the canonical output is
  // pure text (the synthesis itself). Map-reduce relies on this:
  // the reducer reads N drafts and emits a synthesis paragraph, no
  // tools needed. Without this exemption the phantom-no-tools guard
  // tripped on every map-reduce synthesis claim, marking it stale and
  // aborting the run before the synthesizer's text could be harvested.
  // Diagnosed live 2026-04-27 (run_mohzmgie_vfdmxw): synthesizer
  // produced 2660 chars of valid synthesis but was rejected.
  if (todo.kind !== 'synthesize' && editedPaths.length === 0) {
    let realToolPartCount = 0;
    let realPatchPartCount = 0;
    for (const m of messages) {
      if (!newIDs.has(m.info.id)) continue;
      if (m.info.role !== 'assistant') continue;
      for (const p of m.parts) {
        if (p.type === 'tool') realToolPartCount += 1;
        if (p.type === 'patch') realPatchPartCount += 1;
      }
    }
    if (realToolPartCount === 0 && realPatchPartCount === 0) {
      const workerText = extractWorkerAssistantText(messages, newIDs);
      const looksLikeSkip = /^\s*skip\s*:/i.test(workerText);
      if (!looksLikeSkip) {
        const note = '[phantom-no-tools] worker produced text-only response with zero real tool/patch parts and no skip: prefix';
        console.warn(
          `[coordinator] ${meta.swarmRunID}/${todo.id}: ${note} (text=${workerText.length} chars)`,
        );
        const outcome = retryOrStale(meta.swarmRunID, todo, note);
        return {
          kind: 'fail',
          outcome: {
            status: 'stale',
            sessionID,
            itemID: todo.id,
            reason: `${outcome}: phantom-no-tools`,
          },
        };
      }
    }
  }

  // 3. Anti-busywork critic gate. Fail-open: any critic malfunction
  // (spawn failed, timeout, unparseable reply) falls through to done.
  if (meta.enableCriticGate && meta.criticSessionID) {
    const workerText = extractWorkerAssistantText(messages, newIDs);
    const review = await reviewWorkerDiff({
      swarmRunID: meta.swarmRunID,
      criticSessionID: meta.criticSessionID,
      workspace: meta.workspace,
      directive: meta.directive,
      todo,
      editedPaths,
      workerAssistantText: workerText,
      criticModel: meta.criticModel,
    });
    if (review.verdict === 'busywork') {
      const rejected = transitionStatus(meta.swarmRunID, todo.id, {
        from: 'in-progress',
        to: 'stale',
        note: `[critic-rejected] ${review.reason}`.slice(0, 200),
      });
      if (rejected.ok) {
        return {
          kind: 'fail',
          outcome: {
            status: 'stale',
            sessionID,
            itemID: todo.id,
            reason: `critic-rejected: ${review.reason}`,
          },
        };
      }
    }
    if (review.verdict === 'unclear') {
      console.log(
        `[coordinator] ${meta.swarmRunID}/${todo.id}: critic returned 'unclear' (${review.reason}) — failing open`,
      );
    }
  }

  // 4. Playwright grounding. Same fail-open posture as critic. Only
  // applies to items the planner flagged with requiresVerification.
  if (
    todo.requiresVerification &&
    meta.enableVerifierGate &&
    meta.verifierSessionID &&
    meta.workspaceDevUrl
  ) {
    const workerText = extractWorkerAssistantText(messages, newIDs);
    const v = await verifyWorkerOutcome({
      swarmRunID: meta.swarmRunID,
      verifierSessionID: meta.verifierSessionID,
      workspace: meta.workspace,
      workspaceDevUrl: meta.workspaceDevUrl,
      directive: meta.directive,
      todo,
      workerAssistantText: workerText,
      verifierModel: meta.verifierModel,
    });
    if (v.verdict === 'not-verified') {
      const rejected = transitionStatus(meta.swarmRunID, todo.id, {
        from: 'in-progress',
        to: 'stale',
        note: `[verifier-rejected] ${v.reason}`.slice(0, 200),
      });
      if (rejected.ok) {
        return {
          kind: 'fail',
          outcome: {
            status: 'stale',
            sessionID,
            itemID: todo.id,
            reason: `verifier-rejected: ${v.reason}`,
          },
        };
      }
    }
    if (v.verdict === 'unclear') {
      console.log(
        `[coordinator] ${meta.swarmRunID}/${todo.id}: verifier returned 'unclear' (${v.reason}) — failing open`,
      );
    }
  }

  return {
    kind: 'ok',
    context: { ...awaited, fileHashes },
  };
}
