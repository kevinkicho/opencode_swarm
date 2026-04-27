// harvestDrafts — shared fan-out helper for non-ticker orchestrators.
//
// Pattern: snapshot known message IDs per session → fan-out wait via
// waitForSessionIdle (Promise.all so a hung member doesn't block siblings)
// → re-fetch each session's messages and extract the latest completed
// assistant text. Returns one row per session with the text (or null
// on failure / no-text), the wait outcome, and the post-wait knownIDs
// (so multi-round callers like council can scope subsequent waits to
// genuinely-new messages).
//
// Patterns that use this:
// - map-reduce phase 1 (mapper drafts)
// - council per-round drafts
// - phase 1 wraps council, so via that path
//
// Patterns that DON'T use this (different shape):
// - debate-judge: sequential per-session waits
// - critic-loop: only 2 sessions, single sequential cycle
// - blackboard / orchestrator-worker: dispatch, not harvest
//
// Extracted from map-reduce.ts + council.ts in #110.

import 'server-only';

import { getSessionMessagesServer } from './opencode-server';
import { waitForSessionIdle } from './blackboard/coordinator';
import type { SwarmRunMeta } from '@/lib/swarm-run-types';
import type { OpencodeMessage } from '@/lib/opencode/types';

export interface HarvestDraftRow {
 sessionID: string;
 text: string | null;
 ok: boolean;
 reason?: 'timeout' | 'error' | 'silent' | 'provider-unavailable' | 'tool-loop';
 // Post-wait known IDs for this session. Caller can merge back into a
 // shared map for multi-round semantics (council R2..RN). Empty when
 // the message-fetch failed entirely.
 newKnownIDs: Set<string>;
}

export interface HarvestDraftsOpts {
 // Per-session "anything visible at this moment is known" snapshot.
 // Required so the wait scopes itself to messages that arrive AFTER
 // this point. If absent, the helper treats everything as known
 // (effectively waits for any new assistant turn) — this is the
 // map-reduce mapper-phase shape since the dispatch happens just
 // before the wait. For council Round N, pass the prior round's
 // returned knownIDs.
 knownIDsBySession?: ReadonlyMap<string, ReadonlySet<string>>;
 // Wall-clock deadline (epoch ms) for each session's wait. All
 // sessions share the same deadline by design (so a slow member
 // doesn't get rewarded with extra time at the expense of fast
 // siblings).
 deadline: number;
 // Log prefix — "[map-reduce]", "[council]", etc. — used for the
 // wait-failed and message-fetch-failed warnings so the run-context
 // is readable in dev logs.
 contextLabel: string;
}

export async function harvestDrafts(
 meta: SwarmRunMeta,
 opts: HarvestDraftsOpts,
): Promise<HarvestDraftRow[]> {
 const { knownIDsBySession, deadline, contextLabel } = opts;
 return Promise.all(
 meta.sessionIDs.map(async (sid) => {
 const known = knownIDsBySession?.get(sid) ?? new Set<string>();
 const result = await waitForSessionIdle(
 sid,
 meta.workspace,
 new Set(known),
 deadline,
 );
 if (!result.ok) {
 console.warn(
 `${contextLabel} session ${sid} wait failed (${result.reason}) — proceeding with its last completed text`,
 );
 }
 // Whether waitForSessionIdle succeeded or not, fetch the latest
 // state and take the newest completed assistant text part. A
 // partially-done assistant turn often still has a usable final
 // text even on timeout / error / silent.
 let text: string | null = null;
 let newKnownIDs = new Set<string>(known);
 try {
 const msgs = await getSessionMessagesServer(sid, meta.workspace);
 text = extractLatestAssistantText(msgs);
 newKnownIDs = new Set(msgs.map((m) => m.info.id));
 } catch (err) {
 console.warn(
 `${contextLabel} session ${sid} message fetch failed:`,
 err instanceof Error ? err.message : String(err),
 );
 }
 return {
 sessionID: sid,
 text,
 ok: result.ok,
 reason: result.ok ? undefined : result.reason,
 newKnownIDs,
 };
 }),
 );
}

// Pull the latest completed assistant text part. Mirrors the
// "last assistant text" convention used across the orchestrator
// modules.
//
// Pre-fix: this function existed character-identical in 6 files
// (council, critic-loop, debate-judge,, map-reduce,
// harvest-drafts) under copy-paste. Drift risk: a fix in one site
// silently failed to apply to the other 5. Post-fix: all 5 callers
// import from here. STOP — do NOT introduce a polymorphic runPattern()
// interface; the "delete a pattern with one git rm" property is
// load-bearing.
export function extractLatestAssistantText(messages: OpencodeMessage[]): string | null {
 for (let i = messages.length - 1; i >= 0; i -= 1) {
 const m = messages[i];
 if (m.info.role !== 'assistant') continue;
 if (!m.info.time.completed) continue;
 const texts = m.parts.filter(
 (p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text',
 );
 if (texts.length === 0) continue;
 return texts[texts.length - 1].text;
 }
 return null;
}

// Convenience for callers that want to seed knownIDsBySession from a
// fresh snapshot before the first round/phase. Each session's set is
// the message IDs already visible — usually just the directive's
// user message and any pre-existing assistant turns.
export async function snapshotKnownIDs(
 meta: SwarmRunMeta,
 contextLabel: string,
): Promise<Map<string, Set<string>>> {
 const out = new Map<string, Set<string>>();
 for (const sid of meta.sessionIDs) {
 try {
 const msgs = await getSessionMessagesServer(sid, meta.workspace);
 out.set(sid, new Set(msgs.map((m) => m.info.id)));
 } catch (err) {
 console.warn(
 `${contextLabel} session ${sid} initial knownIDs fetch failed:`,
 err instanceof Error ? err.message : String(err),
 );
 out.set(sid, new Set());
 }
 }
 return out;
}
