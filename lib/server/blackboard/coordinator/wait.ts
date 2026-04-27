// waitForSessionIdle — polling watchdog for assistant turn completion.
//
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
//
// The loop carries five layered watchdogs (each with its own commit
// rationale):
//   - F1 silent watchdog (no new parts for SILENT_WARN/ERROR_MS)
//   - F4 ollama-reachability probe (silence + provider-down → fast fail)
//   - tool-loop detector (10× same tool error → abort)
//   - error message detected on a new assistant turn
//   - deadline-with-in-progress abort (#100 — runaway-token leak fix)
//
// Extracted from coordinator.ts in #107 phase 4.

import 'server-only';

import { abortSessionServer, getSessionMessagesServer } from '../../opencode-server';
import { OLLAMA_URL } from '../../../config';
import type { OpencodeMessage } from '../../../opencode/types';

const POLL_INTERVAL_MS = 1000;

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

// Tool-loop detector threshold — 6.12.
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
  const base = OLLAMA_URL.replace(/\/$/, '');
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
  // Sticky in-progress flag — set whenever we observe a new assistant
  // message that hasn't completed yet, cleared whenever every new
  // assistant has completed. Read by the deadline-expiry abort path
  // below. Drives task #100 fix: a worker emitting parts past the
  // ITERATION_WAIT_MS deadline (955K tokens / 30+ min in the
  // MAXTEAM-2026-04-26 critic-loop run) was leaving an in-progress
  // turn alive in opencode forever — silent watchdog never fires
  // (parts ARE growing), tool-loop detector doesn't see structurally-
  // identical errors, deadline-timeout path didn't call abort. Net
  // effect: pattern reports "timeout" up to its caller while opencode
  // keeps burning tokens on the abandoned turn. Tracking in-progress
  // here lets the deadline path abort exactly the runaway case.
  let lastSeenInProgress = false;
 // Tool-loop detector — 6.12. Some
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
          `[coordinator] session ${sessionID} tool-loop: ${toolLoopCount} consecutive '${tool}' errors with same message ("${(err ?? '').slice(0, 80)}…") — aborting`,
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

    if (newAssistants.length === 0) {
      lastSeenInProgress = false;
      continue;
    }

    if (newAssistants.some((m) => !!m.info.error)) {
      return { ok: false, reason: 'error' };
    }

    // Any turn still running? Keep polling.
    if (newAssistants.some((m) => !m.info.time.completed)) {
      lastSeenInProgress = true;
      continue;
    }

    // All turns completed; require a quiet window so we don't catch a
    // between-step state where the next message is about to be created.
    lastSeenInProgress = false;
    const lastCompletedAt = Math.max(
      ...newAssistants
        .map((m) => m.info.time.completed)
        .filter((t): t is number => t != null),
    );
    if (Date.now() - lastCompletedAt < SESSION_IDLE_QUIET_MS) continue;

    return { ok: true, messages, newIDs };
  }
  // Deadline expired. If a turn was still in-progress as of the most
  // recent poll, abort the session so opencode stops generating tokens
  // on a turn the orchestrator has already given up on. Without this,
  // the turn keeps burning tokens forever — observed in MAXTEAM-2026-
  // 04-26 critic-loop where a worker turn ran past 30 minutes / 955K
  // tokens with the orchestrator returning 'timeout' up the stack
  // (the patterns above don't have a place to call abort themselves).
  // We don't abort when the last poll saw all turns completed: those
  // are just stuck on the SESSION_IDLE_QUIET_MS buffer; the session
  // is already idle and aborting would be theater.
  if (lastSeenInProgress) {
    console.error(
      `[coordinator] session ${sessionID} timeout with in-progress turn — aborting (task #100)`,
    );
    try {
      await abortSessionServer(sessionID, workspace);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(
        `[coordinator] timeout abort failed for ${sessionID}: ${detail}`,
      );
    }
  }
  return { ok: false, reason: 'timeout' };
}
