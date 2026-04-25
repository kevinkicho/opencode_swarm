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
// No drift detection yet. When multi-agent parallelism grows teeth, switch
// to pre-snapshot SHAs at claim time and let the existing /commit action
// route handle the drift check.
//
// Server-only. Never imported from client code.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { getRun } from '../swarm-registry';
import {
  abortSessionServer,
  getSessionMessagesServer,
  postSessionMessageServer,
} from '../opencode-server';
import { publishExports } from '../hmr-exports';
import { opencodeAgentForSession, roleNamesBySessionID } from '@/lib/blackboard/roles';
import { reviewWorkerDiff } from './critic';
import { verifyWorkerOutcome } from './verifier';
import { listBoardItems, transitionStatus } from './store';
import { toFileHeat, type FileHeat } from '@/lib/opencode/transform';
import type { BoardItem } from '@/lib/blackboard/types';
import type { OpencodeMessage } from '@/lib/opencode/types';

// Shared key for HMR-resilient consumer lookups (see lib/server/hmr-exports.ts).
// Export so consumers can import it alongside the types.
export const COORDINATOR_EXPORTS_KEY = Symbol.for(
  'opencode_swarm.coordinator.exports',
);
export interface CoordinatorExports {
  // Forward-declare typeof — actual definitions below; TS hoists function
  // types so the declaration order works out.
  tickCoordinator: (
    swarmRunID: string,
    opts?: {
      restrictToSessionID?: string;
      excludeSessionIDs?: readonly string[];
    },
  ) => Promise<TickOutcome>;
  waitForSessionIdle: (
    sessionID: string,
    workspace: string,
    knownIDs: Set<string>,
    deadline: number,
  ) =>
    Promise<
      | { ok: true; messages: OpencodeMessage[]; newIDs: Set<string> }
      | { ok: false; reason: 'timeout' | 'error' | 'silent' | 'provider-unavailable' | 'tool-loop' }
    >;
}

const POLL_INTERVAL_MS = 1000;
// Raised from 5 min to 10 min after the 2026-04-23 overnight run showed
// substantive README-verification todos ("Verify CreditMarket EM bonds
// spread data rendering") legitimately running past 5 min — not zombies,
// just slow work involving multiple reads + a test file edit + a test
// run. The zombie auto-abort in the picker already handles truly-stuck
// sessions at 10 min, so the worker timeout matches that boundary.
//
// Per-pattern tuning mirrors ZOMBIE_TURN_THRESHOLDS_MS: patterns whose
// turns legitimately take longer get more budget. deliberate-execute's
// synthesis phase reconciles N drafts + writes todowrite — slower than
// a single-file edit. critic-loop's worker turns are typically tight
// revisions on a focused target, so a shorter timeout catches hung
// turns faster without losing legitimate work. Patterns not in the map
// fall back to DEFAULT_TURN_TIMEOUT_MS.
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
const TURN_TIMEOUTS_MS: Record<string, number> = {
  blackboard: 10 * 60_000,
  'orchestrator-worker': 10 * 60_000,
  'role-differentiated': 10 * 60_000,
  'deliberate-execute': 15 * 60_000,
};
function turnTimeoutFor(pattern: string): number {
  return TURN_TIMEOUTS_MS[pattern] ?? DEFAULT_TURN_TIMEOUT_MS;
}

// Per-pattern zombie threshold for the session picker. opencode assistant
// turns can hang with no completed AND no error (see
// memory/reference_opencode_zombie_messages.md) — in-flight indefinitely,
// silently blocking dispatch because the picker skips any session with an
// active in-flight turn. After this many ms, the picker treats the turn
// as stale: auto-aborts it and dispatches to the session anyway.
//
// Only blackboard-family patterns (blackboard / orchestrator-worker /
// role-differentiated / deliberate-execute) run through tickCoordinator,
// so those are the only values that matter in practice. 10 min is the
// legacy default and works for typical refactor work; deliberate-execute's
// synthesis phase gets more headroom because reconciling N council drafts
// legitimately takes longer than a single-file edit.
const ZOMBIE_TURN_THRESHOLD_DEFAULT_MS = 10 * 60_000;
const ZOMBIE_TURN_THRESHOLDS_MS: Record<string, number> = {
  blackboard: 10 * 60_000,
  'orchestrator-worker': 10 * 60_000,
  'role-differentiated': 10 * 60_000,
  'deliberate-execute': 15 * 60_000,
};
function zombieThresholdFor(pattern: string): number {
  return ZOMBIE_TURN_THRESHOLDS_MS[pattern] ?? ZOMBIE_TURN_THRESHOLD_DEFAULT_MS;
}

// How long the session must be silent (no new activity, all turns completed)
// before we treat it as "done". opencode emits one assistant message per
// step (read → todowrite → wrap-up text …), each with its own `completed`
// timestamp. A poll that catches the session between steps would see every
// existing turn completed yet still have more work coming. 2s has empirically
// covered the inter-step gap observed in e2e runs (inter-message creation
// gap is typically <100ms but the buffer gives headroom for slower
// backend flushes).
const SESSION_IDLE_QUIET_MS = 2000;

// Dispatch watchdog thresholds — POSTMORTEMS/2026-04-24 F1. The
// silent-failure case (run_mod5dy6n_utsb32) had 15 minutes of zero
// activity between dispatch and the planner's timeout. The watchdog
// counts message parts inside waitForSessionIdle and:
//   - logs WARN at SILENT_WARN_MS of no-new-parts
//   - logs ERROR + aborts the session at SILENT_ERROR_MS
// 90s / 240s thresholds chosen to be tight enough to catch the 15-min
// hang case fast, but loose enough that legitimately-slow models
// (ollama cloud cold-starts, large prompts) don't spuriously fire.
// The first part typically lands within 5-30s; nothing in 90s means
// the call almost certainly didn't reach the provider.
const SILENT_WARN_MS = 90 * 1000;
const SILENT_ERROR_MS = 240 * 1000;

// Tool-loop detector threshold — PATTERN_DESIGN/blackboard.md 6.12.
// 10 consecutive identical tool errors (same tool name + same error
// message) within a single turn means the model is stuck retrying a
// structurally-broken call. Each retry burns ~10-30 K input tokens
// (full conversation history reposted as context); 10 retries =
// ~100-300 K tokens of pure waste. The threshold is also low
// enough that legitimate "model fixes itself on retry 3-4" cases
// don't trip — those resolve well before 10.
const TOOL_LOOP_THRESHOLD = 10;

// Ollama daemon reachability probe — POSTMORTEMS/2026-04-24 F4. Fires
// inside the watchdog only when silence already crossed PROBE_AFTER_MS
// (30s). Checks that the local ollama daemon is responding to /api/ps;
// if it isn't, the provider is unreachable (network drop, ollama
// killed, port shift) and we should fail fast rather than waiting out
// the 15-min planner timeout. Probe interval is throttled inside the
// loop — once-per-poll-window beats once-per-tick.
const PROBE_AFTER_MS = 30 * 1000;
const PROBE_INTERVAL_MS = 30 * 1000;
const PROBE_TIMEOUT_MS = 5 * 1000;
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

async function probeOllamaPs(): Promise<{ ok: boolean; detail?: string }> {
  const base = (process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/ps`, {
      method: 'GET',
      signal: ac.signal,
    });
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// PATTERN_DESIGN/blackboard.md I1 — auto-replan on CAS drift.
// Fired from the commit-time drift check above. Schedules a fresh
// planner sweep so a replacement todo lands within seconds of drift,
// rather than waiting for the next periodic sweep cadence.
//
// Throttle: read the run's plan_revisions ledger; skip the call if a
// sweep landed in the last CAS_REPLAN_MIN_INTERVAL_MS window. Several
// concurrent workers hitting drift on adjacent files all schedule a
// replan but only the first one gets through; the rest no-op.
//
// Dynamic import of './planner' breaks the otherwise-circular dep
// (planner imports waitForSessionIdle from this module).
const CAS_REPLAN_MIN_INTERVAL_MS = 60 * 1000;
async function scheduleCasDriftReplan(
  swarmRunID: string,
  driftedPaths: string[],
): Promise<void> {
  try {
    const { listPlanRevisions } = await import('./plan-revisions');
    const revisions = listPlanRevisions(swarmRunID);
    const last = revisions[0]; // newest-first
    if (last && Date.now() - last.createdAt < CAS_REPLAN_MIN_INTERVAL_MS) {
      console.log(
        `[coordinator] CAS-drift replan throttled (${swarmRunID}): last sweep ${Math.round((Date.now() - last.createdAt) / 1000)}s ago — skipping`,
      );
      return;
    }
    const { runPlannerSweep } = await import('./planner');
    console.log(
      `[coordinator] CAS-drift replan firing for ${swarmRunID} on ${driftedPaths.length} drifted file(s) (PATTERN_DESIGN/blackboard.md I1)`,
    );
    await runPlannerSweep(swarmRunID, {
      overwrite: true,
      includeBoardContext: true,
    });
  } catch (err) {
    console.warn(
      `[coordinator] CAS-drift replan failed for ${swarmRunID}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

// Owner-id convention for the coordinator: ag_ses_<last8>. Keeps the id
// short for UI columns while remaining unambiguous per session. Matches the
// "board ownerAgentId is whatever the writer posts" contract in
// lib/blackboard/types.ts — derivation happens in the UI.
export function ownerIdForSession(sessionID: string): string {
  return 'ag_ses_' + sessionID.slice(-8);
}

export type TickOutcome =
  | { status: 'picked'; sessionID: string; itemID: string; editedPaths: string[] }
  | { status: 'stale'; sessionID: string; itemID: string; reason: string }
  | { status: 'skipped'; reason: string };

export interface TickOpts {
  timeoutMs?: number;
  // Restrict the session picker to a single sessionID. When set, the tick
  // uses that session if idle, or returns skipped otherwise — it does not
  // fall back to other sessions. The auto-ticker passes this to fan out
  // one tick per session in parallel; map-reduce synthesis omits it so
  // any idle session can claim the synthesize item.
  restrictToSessionID?: string;
  // Exclude these sessions from the dispatch picker. Used by the
  // orchestrator-worker pattern to keep the orchestrator (session 0)
  // focused on planning while only workers (sessions 1..N) claim todos.
  // Applied before restrictToSessionID — a session in both is excluded.
  excludeSessionIDs?: readonly string[];
}

// Same pattern as planner.ts::sha7 — 7-char git-short SHA1 of file contents.
async function sha7(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  return createHash('sha1').update(buf).digest('hex').slice(0, 7);
}

// Stale-retry budget. When a worker times out or errors on a todo,
// instead of terminating the todo as `stale` forever, requeue it as
// `open` so another tick can pick it up. The retry count is stored in
// the todo's note — after MAX_STALE_RETRIES, the item stays stale.
//
// Why: a single transient failure (slow tool call, temporarily-offline
// upstream, hit a 5-min deadline mid-work) shouldn't drop the todo from
// the swarm's work queue. The user was explicit about wanting stale
// items to not "die silently."
const MAX_STALE_RETRIES = 2;
const RETRY_TAG_RE = /^\[retry:(\d+)\]\s*/;

function currentRetryCount(note: string | null | undefined): number {
  if (!note) return 0;
  const m = RETRY_TAG_RE.exec(note);
  return m ? Number(m[1]) : 0;
}

// Transition an in-progress item into either `open` (retry) or `stale`
// (final) based on accumulated retry count in the note field. Preserves
// the failure reason in the note so inspector / rail views still show
// why the previous attempt failed.
function retryOrStale(
  swarmRunID: string,
  item: BoardItem,
  reason: string,
): 'retry' | 'stale' {
  const retries = currentRetryCount(item.note);
  if (retries < MAX_STALE_RETRIES) {
    const nextNote = `[retry:${retries + 1}] ${reason}`.slice(0, 200);
    transitionStatus(swarmRunID, item.id, {
      from: 'in-progress',
      to: 'open',
      ownerAgentId: null,
      fileHashes: null,
      note: nextNote,
    });
    return 'retry';
  }
  transitionStatus(swarmRunID, item.id, {
    from: 'in-progress',
    to: 'stale',
    note: `[final after ${retries} retries] ${reason}`.slice(0, 200),
  });
  return 'stale';
}

// File-path-ish tokens inside a todo's content. Used to detect overlap
// with an in-progress item's content so two sessions don't trample each
// other's files. Matches: dir-ish (src/foo/bar), file-ish with common
// extensions, and bare basenames ≥4 chars with an extension. Tokens
// under 4 chars are skipped — "ts" / "js" would be noise.
const PATH_TOKEN_RE = /[a-zA-Z_][\w.-]*(?:\/[\w.-]+)+\/?|\b\w{4,}\.(?:ts|tsx|js|jsx|py|go|rs|md|css|html|json|yaml|yml|toml)\b/g;

function extractPathTokens(content: string): Set<string> {
  const out = new Set<string>();
  const matches = content.match(PATH_TOKEN_RE) ?? [];
  for (const m of matches) out.add(m.replace(/\\/g, '/').replace(/\/$/, ''));
  return out;
}

function pathOverlaps(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      if (x.startsWith(y + '/')) return true; // y is ancestor of x
      if (y.startsWith(x + '/')) return true; // x is ancestor of y
    }
  }
  return false;
}

// Stigmergy v1 — pheromone-weighted pick. Score a todo by summing the
// edit counts of heat entries whose path or containing dir or basename
// appears in the todo's content. Three match tiers:
//
//   * Full-path match (content includes `src/foo/bar.ts`): +2x count
//     — strong signal, the todo explicitly names the file
//   * Directory match (content includes `src/foo/` when h.path is
//     `src/foo/bar.ts`): +1x count — todo targets the dir that owns
//     this file. Covers the "fix everything in src/components/" case.
//   * Basename match (content includes `bar.ts`, len ≥ 4): +1x count
//     — weakest, covers the "edit bar.ts" case where h.path has a
//     different leading dir
//
// Basenames under 4 chars are skipped — matching "ts" or "js" would
// be noise. The picker sorts OPEN todos by this score ASC
// (exploratory bias — steer workers toward unexplored files) with
// createdAtMs ASC as the tiebreak. A todo with no file attribution
// scores 0 and falls back to oldest-first, which is the correct
// degenerate case.
// PATTERN_DESIGN/stigmergy.md I1 — heat half-life decay. Without this,
// editCount accumulates forever and an early-hot file dominates the
// score for hours after it's been quiet, anchoring the swarm. Decay
// weights each file's contribution by 0.5^(Δt / HEAT_HALF_LIFE_MS),
// where Δt is wallclock since the file was last touched. Recent
// edits count fully; old edits fade out. Half-life is configurable
// via OPENCODE_HEAT_HALF_LIFE_S (seconds); default 1800 (30 min)
// is gentler than the spec's 130s but matches our typical session
// pacing. Override to 130 for spec-literal validation runs.
const HEAT_HALF_LIFE_DEFAULT_MS = 30 * 60 * 1000;
function heatHalfLifeMs(): number {
  const env = process.env.OPENCODE_HEAT_HALF_LIFE_S;
  if (!env) return HEAT_HALF_LIFE_DEFAULT_MS;
  const n = parseInt(env, 10);
  if (!Number.isFinite(n) || n <= 0) return HEAT_HALF_LIFE_DEFAULT_MS;
  return n * 1000;
}
function decayFactor(lastTouchedMs: number): number {
  if (lastTouchedMs <= 0) return 1; // unknown timestamp = no decay
  const dt = Math.max(0, Date.now() - lastTouchedMs);
  return Math.pow(0.5, dt / heatHalfLifeMs());
}

function scoreTodoByHeat(
  content: string,
  heat: FileHeat[],
  pickedSessionID?: string,
): number {
  let score = 0;
  for (const h of heat) {
    const norm = h.path.replace(/\\/g, '/');
    const lastSlash = norm.lastIndexOf('/');
    const base = lastSlash >= 0 ? norm.slice(lastSlash + 1) : norm;
    const dirWithSlash = lastSlash >= 0 ? norm.slice(0, lastSlash + 1) : '';
    const decay = decayFactor(h.lastTouchedMs);
    const decayedCount = h.editCount * decay;
    let weight = 0;
    if (content.includes(h.path) || content.includes(norm)) {
      weight = 2;
    } else if (dirWithSlash && content.includes(dirWithSlash)) {
      weight = 1;
    } else if (base.length >= 4 && content.includes(base)) {
      weight = 1;
    }
    if (weight > 0) {
      score += decayedCount * weight;
      // PATTERN_DESIGN/stigmergy.md I4 — per-worker warmth bonus.
      // Picker sorts ascending (low-heat = preferred), so subtracting
      // here biases the picked session toward files it has already
      // touched (exploitation). Coefficient 0.5 keeps the global
      // exploratory bias dominant when the worker is one of many
      // touchers, but lets a sole-toucher tip toward continuing where
      // they have session context.
      if (pickedSessionID) {
        const sessionEdits = h.editsBySession?.[pickedSessionID] ?? 0;
        if (sessionEdits > 0) {
          score -= 0.5 * sessionEdits * decay * weight;
        }
      }
    }
  }
  return score;
}

function isAssistantComplete(m: OpencodeMessage): boolean {
  return m.info.role === 'assistant' && !!m.info.time.completed;
}

function isAssistantInFlight(m: OpencodeMessage): boolean {
  return (
    m.info.role === 'assistant' &&
    !m.info.time.completed &&
    !m.info.error
  );
}

// How long has the oldest in-flight assistant turn been running? Returns 0
// when the session has no in-flight turns. Used by the session picker to
// distinguish legitimate long-running work from zombies.
function oldestInFlightAgeMs(messages: OpencodeMessage[]): number {
  let oldest: number | null = null;
  for (const m of messages) {
    if (!isAssistantInFlight(m)) continue;
    const created = m.info.time.created;
    if (typeof created !== 'number') continue;
    if (oldest === null || created < oldest) oldest = created;
  }
  if (oldest === null) return 0;
  return Date.now() - oldest;
}

// Which files did the turn edit? `patch` parts carry `files: string[]`
// (one part per turn that committed edits — see lib/opencode/types.ts). We
// union across every patch part in the scoped messages, so a turn that
// touches the same file twice produces one entry.
function extractEditedPaths(
  messages: OpencodeMessage[],
  scopeMessageIDs: Set<string>,
): string[] {
  const paths = new Set<string>();
  for (const m of messages) {
    if (!scopeMessageIDs.has(m.info.id)) continue;
    for (const part of m.parts) {
      if (part.type !== 'patch') continue;
      for (const f of part.files) paths.add(f);
    }
  }
  return [...paths];
}

// Concatenate the text-part content of new assistant messages in the
// scope. Used by the critic gate to show the reviewer what the worker
// "said" about the turn (argument, claim, summary). Keeps only the last
// assistant message's text — that's usually the closing summary; prior
// steps are tool calls + reasoning we don't need to show the critic.
function extractWorkerAssistantText(
  messages: OpencodeMessage[],
  scopeMessageIDs: Set<string>,
): string {
  let last = '';
  for (const m of messages) {
    if (!scopeMessageIDs.has(m.info.id)) continue;
    if (m.info.role !== 'assistant') continue;
    const text = m.parts
      .flatMap((p) => (p.type === 'text' ? [p.text] : []))
      .join('')
      .trim();
    if (text) last = text;
  }
  return last;
}

// opencode reports absolute paths in `patch.files` (e.g. on Windows,
// `C:/Users/.../components/foo.tsx`). The board stores fileHashes for
// cross-run comparison — absolute host paths make those records useless
// if the repo ever moves. Relativize against the run's workspace and
// normalize to forward slashes; fall back to the absolute path if the
// edit landed outside the workspace (e.g. a shared config), since we'd
// rather record something truthful than pretend an out-of-tree edit is
// local.
function relativizeToWorkspace(workspace: string, p: string): string {
  const rel = path.relative(workspace, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return p.replace(/\\/g, '/');
  }
  return rel.replace(/\\/g, '/');
}

function buildWorkPrompt(item: BoardItem): string {
  // Synthesize items carry a complete, self-contained prompt (member drafts
  // already embedded by the caller). Wrapping them in the blackboard-edit
  // preamble would both mangle the synthesis directive and mislead the
  // synthesizer into editing files. Post the content verbatim and let the
  // CAS lifecycle handle progression.
  if (item.kind === 'synthesize') return item.content;
  const lines: string[] = [
    'Blackboard work prompt.',
    '',
    `Todo id: ${item.id}`,
    `Todo: ${item.content}`,
  ];
  // Pre-announced file scope (declared-roles alignment). When the
  // planner tagged the todo with [files:a,b], the coordinator has
  // already hashed those files at claim time for CAS drift detection;
  // the worker MUST stay within this list or risk the commit being
  // rejected as out-of-scope (future Stage 2 enforcement). Today this
  // is a soft instruction plus a hard CAS check on drift at commit.
  if (item.expectedFiles && item.expectedFiles.length > 0) {
    lines.push(
      '',
      `Expected file scope (DO NOT edit files outside this list): ${item.expectedFiles.join(', ')}`,
      'Other workers have claims on other files. Editing outside this',
      'scope risks a CAS-drift rejection at commit time.',
    );
  }
  lines.push(
    '',
    'Complete this todo by editing the file(s) above directly. Keep the',
    'scope narrow — one todo, one change. Do not call the task tool, do',
    'not spawn sub-agents. When done, reply with a one-sentence summary.',
    '',
    'If the todo turns out to be wrong or already done, reply "skip:" with',
    'a one-line reason and do not edit anything.',
  );
  return lines.join('\n');
}

// Poll until the session has finished processing whatever prompt we just
// posted. A naive "first completed assistant message" check races
// multi-step responses: opencode commits msg_1 (tool:read) → msg_2
// (tool:todowrite) → msg_3 (wrap-up text) as separate assistant records,
// each with its own completed timestamp. The planner and coordinator both
// want the FULL response, not the first step. Shared here so fixes land
// in one place.
//
// Exit conditions:
//   ok=true   every new assistant message is completed, AND at least
//             SESSION_IDLE_QUIET_MS has passed since the most recent
//             completion (so we're not mid-sequence).
//   ok=false  any new assistant message has an `error`; or the deadline
//             fires before the session goes idle.
export async function waitForSessionIdle(
  sessionID: string,
  workspace: string,
  knownIDs: Set<string>,
  deadline: number,
): Promise<
  | { ok: true; messages: OpencodeMessage[]; newIDs: Set<string> }
  | { ok: false; reason: 'timeout' | 'error' | 'silent' | 'provider-unavailable' | 'tool-loop' }
> {
  // Dispatch watchdog state — F1. We track total parts across all
  // new-since-dispatch assistant messages, plus the wallclock at last
  // change. Initial state: zero parts seen, lastActivityTs = now.
  // If parts count grows on a poll, we reset the silence timer. If
  // the silence stays past SILENT_WARN_MS we log WARN once, and at
  // SILENT_ERROR_MS we abort + return silent.
  //
  // F4 layer: once silence crosses PROBE_AFTER_MS, we periodically
  // probe ollama's /api/ps. If the daemon doesn't respond we return
  // 'provider-unavailable' instead of waiting for the silent-error
  // threshold — sharper signal, faster recovery.
  const watchdogStartedMs = Date.now();
  let lastActivityMs = watchdogStartedMs;
  let lastTotalParts = 0;
  let warnedSilent = false;
  let lastProbeMs = 0;
  // Tool-loop detector — PATTERN_DESIGN/blackboard.md 6.12. Some
  // models (notably gemma4:31b-cloud on the `edit` tool) burn entire
  // turns retrying a structurally-broken tool call with near-identical
  // arguments — e.g. an `oldString` that doesn't match because of
  // whitespace, hallucinated syntax, etc. opencode's per-turn tool
  // cap doesn't break this loop because each retry is "valid". We
  // track consecutive same-tool same-error count; when it crosses
  // TOOL_LOOP_THRESHOLD we abort the turn and surface 'tool-loop'.
  // The coordinator marks the item stale with a [tool-loop] note so
  // the user can see what happened at a glance and the planner can
  // decide whether to rephrase the todo on the next sweep.
  // Observed in `run_modm7vsw_uxxy6b` worker-2: 101 consecutive
  // `edit` errors all "Could not find oldString in the file" before
  // the (15-minute) planner timeout finally bailed.
  let lastFailedToolKey: string | null = null;
  let toolLoopCount = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const messages = await getSessionMessagesServer(sessionID, workspace);
    const newIDs = new Set(
      messages.filter((m) => !knownIDs.has(m.info.id)).map((m) => m.info.id),
    );
    const newAssistants = messages.filter(
      (m) => newIDs.has(m.info.id) && m.info.role === 'assistant',
    );

    // Watchdog: total parts across all new assistant messages. A new
    // part = the model emitted SOMETHING since last poll, even if no
    // turn has completed. Also count messages themselves so a fresh
    // assistant message with zero parts still resets the watchdog
    // (caught the create event before any part lands).
    const totalParts = newAssistants.reduce(
      (sum, m) => sum + m.parts.length,
      0,
    );
    if (totalParts !== lastTotalParts || newAssistants.length > 0) {
      // Any forward progress (new message OR new part) resets the timer.
      // newAssistants.length>0 alone catches the rare case where the
      // first message has zero parts initially but exists.
      if (totalParts !== lastTotalParts) {
        lastActivityMs = Date.now();
        lastTotalParts = totalParts;
        warnedSilent = false;
      }
    }

    const silentMs = Date.now() - lastActivityMs;

    // F4 — provider reachability probe. Only fires once silence
    // crosses PROBE_AFTER_MS, throttled to PROBE_INTERVAL_MS so we
    // don't hammer ollama on every poll. If the daemon is unreachable
    // we don't wait for the silent-error threshold — fail fast as
    // 'provider-unavailable' so the caller can route to the retry/
    // stale path immediately. False-positive risk: a 5s probe timeout
    // during legitimate ollama load is rare; the probe is GET-only
    // and ollama answers /api/ps in single-digit ms when healthy.
    if (silentMs >= PROBE_AFTER_MS && Date.now() - lastProbeMs >= PROBE_INTERVAL_MS) {
      lastProbeMs = Date.now();
      const probe = await probeOllamaPs();
      if (!probe.ok) {
        console.error(
          `[coordinator] session ${sessionID} silent ${Math.round(silentMs / 1000)}s + ollama unreachable (${probe.detail ?? 'no detail'}) — aborting (F4 probe)`,
        );
        try {
          await abortSessionServer(sessionID, workspace);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          console.warn(
            `[coordinator] F4 abort failed for ${sessionID}: ${detail}`,
          );
        }
        return { ok: false, reason: 'provider-unavailable' };
      }
    }

    if (silentMs >= SILENT_ERROR_MS) {
      const ageS = Math.round(silentMs / 1000);
      console.error(
        `[coordinator] session ${sessionID} silent ${ageS}s — aborting (F1 watchdog)`,
      );
      try {
        await abortSessionServer(sessionID, workspace);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(
          `[coordinator] watchdog abort failed for ${sessionID}: ${detail}`,
        );
      }
      return { ok: false, reason: 'silent' };
    }
    if (silentMs >= SILENT_WARN_MS && !warnedSilent) {
      const ageS = Math.round(silentMs / 1000);
      console.warn(
        `[coordinator] session ${sessionID} silent ${ageS}s — provider may be unreachable (F1 watchdog)`,
      );
      warnedSilent = true;
    }

    // Tool-loop detector — count consecutive identical tool errors
    // across all the new assistant messages in this turn. When the
    // count crosses TOOL_LOOP_THRESHOLD we abort. Done inside the
    // poll loop so we catch it BEFORE the turn keeps generating
    // wasted retries — earlier exit beats the silent-watchdog
    // because the model is actively producing content (not silent),
    // it's just producing the same broken call.
    {
      const errorParts: Array<{ tool: string; error: string }> = [];
      for (const m of newAssistants) {
        for (const p of m.parts) {
          if (p.type !== 'tool') continue;
          const state = p.state as { status?: string; error?: string } | undefined;
          if (state?.status !== 'error') continue;
          errorParts.push({
            tool: String(p.tool ?? 'unknown'),
            error: String(state.error ?? ''),
          });
        }
      }
      // Walk the trailing tail of error parts to count the longest
      // suffix where (tool, error) is identical. That's the
      // "consecutive identical errors right now" measure.
      let suffixCount = 0;
      let suffixKey: string | null = null;
      for (let i = errorParts.length - 1; i >= 0; i -= 1) {
        const key = errorParts[i].tool + '|' + errorParts[i].error;
        if (suffixKey === null) {
          suffixKey = key;
          suffixCount = 1;
        } else if (suffixKey === key) {
          suffixCount += 1;
        } else {
          break;
        }
      }
      if (suffixKey !== null && suffixKey !== lastFailedToolKey) {
        // New error key — reset (the model switched failure modes).
        lastFailedToolKey = suffixKey;
        toolLoopCount = suffixCount;
      } else if (suffixKey !== null) {
        toolLoopCount = suffixCount;
      }
      if (toolLoopCount >= TOOL_LOOP_THRESHOLD) {
        const [tool, err] = (suffixKey ?? '|').split('|', 2);
        console.error(
          `[coordinator] session ${sessionID} tool-loop: ${toolLoopCount} consecutive '${tool}' errors with same message ("${(err ?? '').slice(0, 80)}…") — aborting (PATTERN_DESIGN/blackboard.md 6.12)`,
        );
        try {
          await abortSessionServer(sessionID, workspace);
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e);
          console.warn(
            `[coordinator] tool-loop abort failed for ${sessionID}: ${detail}`,
          );
        }
        return { ok: false, reason: 'tool-loop' };
      }
    }

    if (newAssistants.length === 0) continue;

    if (newAssistants.some((m) => !!m.info.error)) {
      return { ok: false, reason: 'error' };
    }

    // Any turn still running? Keep polling.
    if (newAssistants.some((m) => !m.info.time.completed)) continue;

    // All turns completed; require a quiet window so we don't catch a
    // between-step state where the next message is about to be created.
    const lastCompletedAt = Math.max(
      ...newAssistants
        .map((m) => m.info.time.completed)
        .filter((t): t is number => t != null),
    );
    if (Date.now() - lastCompletedAt < SESSION_IDLE_QUIET_MS) continue;

    return { ok: true, messages, newIDs };
  }
  return { ok: false, reason: 'timeout' };
}

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
    const reason =
      waited.reason === 'timeout'
        ? 'turn timed out'
        : waited.reason === 'silent'
          ? 'turn went silent'
          : waited.reason === 'provider-unavailable'
            ? 'provider-unavailable'
            : waited.reason === 'tool-loop'
              ? 'tool-loop'
              : 'turn errored';
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
      const detail = driftedPaths.slice(0, 3).join(',');
      const more = driftedPaths.length > 3 ? ` +${driftedPaths.length - 3}` : '';
      const note = `[cas-drift:${detail}${more}]`;
      console.log(
        `[coordinator] ${swarmRunID}/${todo.id}: CAS drift on ${driftedPaths.length} file(s) (${detail}${more}) — moving to stale before critic`,
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
          reason: `cas-drift: ${detail}${more}`,
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

// Publish to globalThis so HMR-replaced modules propagate to existing
// consumers (auto-ticker's setInterval callbacks, map-reduce's
// runMapReduceSynthesis, council's runCouncilRounds) without requiring
// those consumers to restart. See lib/server/hmr-exports.ts for the
// rationale and pattern.
publishExports<CoordinatorExports>(COORDINATOR_EXPORTS_KEY, {
  tickCoordinator,
  waitForSessionIdle,
});
