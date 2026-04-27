#!/usr/bin/env node
// Comprehensive run observer — emits every state delta across all
// data crossroads of an active swarm run. Designed to run ALONGSIDE
// the validation sweep (or by itself) so we get rich live signal
// instead of just coarse pass/fail verdicts.
//
// Tracked endpoints (poll every 5s):
//   /api/swarm/run/<id>/snapshot    — run.status, derivedRow.tokensTotal,
//                                     board.items, ticker, planRevisions
//   /api/swarm/run/<id>/tokens      — per-session token breakdown
//   /api/opencode/session/<sid>/message?directory=<ws>  — per-session
//                                     message graph, completed assistants,
//                                     tool calls by name, errors
//
// Tracked sessions: every meta.sessionIDs[] entry, plus the auditor /
// critic / verifier sessions if registered (those run outside the
// teamSession array but are part of the run's compute).
//
// Emit format:
//   [HH:MM:SS][KIND][SCOPE] payload
//
// KIND values:
//   STATUS  — run status transitions (live → idle / stale / error)
//   TOKENS  — total token delta + per-session deltas
//   MSGS    — per-session message count delta (incl. completion flips)
//   TOOL    — per-session tool-call delta (with tool name)
//   BOARD   — board item count + per-status transitions
//   PLAN    — planRevisions count delta
//   TICKER  — ticker state / totalCommits / lastOutcome change
//   ERROR   — session error, item error, snapshot 5xx
//
// SCOPE values:
//   run     — run-level signal
//   ses[i]  — session at index i (i=0 is planner/orchestrator)
//   audit   — auditor session
//   critic  — critic session
//   verify  — verifier session
//   board   — board-level signal
//   ticker  — ticker-level signal
//
// Usage: node scripts/_run_observer.mjs <swarmRunID> [maxSec]
//   maxSec defaults to 900 (15 min hard cap on the observer itself)

import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import process from 'node:process';

const RUN_ID = process.argv[2];
const HARD_CAP_SEC = Number(process.argv[3] ?? 900);
const POLL_MS = 5000;

if (!RUN_ID) {
  console.error('usage: node _run_observer.mjs <swarmRunID> [maxSec]');
  process.exit(1);
}

let port;
try {
  port = readFileSync('.dev-port', 'utf8').trim();
} catch {
  console.error('FATAL: .dev-port missing — start dev server first');
  process.exit(1);
}
const BASE = `http://localhost:${port}`;
const startMs = Date.now();
const elapsed = () => Math.round((Date.now() - startMs) / 1000);

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

function emit(kind, scope, payload) {
  process.stdout.write(`[${ts()}][${kind}][${scope}] ${payload}\n`);
}

async function fetchJson(path) {
  try {
    const res = await fetch(`${BASE}${path}`, { cache: 'no-store' });
    if (!res.ok) return { __error: `HTTP ${res.status}` };
    return res.json();
  } catch (err) {
    return { __error: err.message?.slice(0, 100) || 'fetch failed' };
  }
}

async function probeSession(sid, label, workspace) {
  const ws = encodeURIComponent(workspace);
  const res = await fetch(
    `${BASE}/api/opencode/session/${sid}/message?directory=${ws}`,
    { cache: 'no-store' },
  );
  if (!res.ok) {
    return { label, sid, msgCount: 0, completedAssistants: 0, toolCalls: {}, error: `HTTP ${res.status}` };
  }
  const messages = await res.json();
  if (!Array.isArray(messages)) {
    return { label, sid, msgCount: 0, completedAssistants: 0, toolCalls: {}, error: 'non-array' };
  }
  let completedAssistants = 0;
  const toolCalls = {};
  let lastError = null;
  for (const m of messages) {
    const info = m.info ?? {};
    if (info.role === 'assistant' && info.time?.completed) completedAssistants++;
    if (info.error) lastError = info.error;
    for (const part of m.parts ?? []) {
      if (part.type === 'tool' && part.toolName) {
        toolCalls[part.toolName] = (toolCalls[part.toolName] ?? 0) + 1;
      }
    }
  }
  return { label, sid, msgCount: messages.length, completedAssistants, toolCalls, error: lastError };
}

const seen = {
  status: null,
  tokensTotal: 0,
  itemsByStatus: {},
  totalItems: 0,
  planRevisions: 0,
  tickerState: null,
  tickerCommits: 0,
  tickerLastOutcome: null,
  sessionMsgCount: {},     // sid → msgCount
  sessionCompleted: {},    // sid → completedAssistants
  sessionTools: {},        // sid → { toolName: count }
  sessionError: {},        // sid → last error string
  meta: null,              // cache run meta
};

async function poll() {
  const t = elapsed();

  // ─── Snapshot (run-level) ─────────────────────────────────────────
  const snap = await fetchJson(`/api/swarm/run/${RUN_ID}/snapshot`);
  if (snap.__error) {
    emit('ERROR', 'run', `snapshot fetch failed: ${snap.__error}`);
    return false;
  }

  if (!seen.meta) seen.meta = snap.meta;

  // Status
  const status = snap.status ?? 'unknown';
  if (status !== seen.status) {
    emit('STATUS', 'run', `${seen.status ?? 'init'} → ${status} @ ${t}s`);
    seen.status = status;
  }

  // Tokens
  const tokens = snap.derivedRow?.tokensTotal ?? 0;
  if (tokens !== seen.tokensTotal) {
    const delta = tokens - seen.tokensTotal;
    emit('TOKENS', 'run', `${seen.tokensTotal} → ${tokens} (Δ+${delta}) @ ${t}s`);
    seen.tokensTotal = tokens;
  }

  // Plan revisions
  const planRevs =
    typeof snap.planRevisions === 'object' && snap.planRevisions !== null
      ? snap.planRevisions.count ?? 0
      : Array.isArray(snap.planRevisions)
        ? snap.planRevisions.length
        : 0;
  if (planRevs !== seen.planRevisions) {
    emit('PLAN', 'run', `planRevisions ${seen.planRevisions} → ${planRevs}`);
    seen.planRevisions = planRevs;
  }

  // Board items
  const items = snap.board?.items ?? snap.items ?? [];
  const byStatus = {};
  for (const i of items) byStatus[i.status ?? '?'] = (byStatus[i.status ?? '?'] ?? 0) + 1;
  if (items.length !== seen.totalItems) {
    emit('BOARD', 'board', `total ${seen.totalItems} → ${items.length} (${JSON.stringify(byStatus)})`);
    seen.totalItems = items.length;
  } else {
    // Same total but maybe transitions between statuses
    for (const k of new Set([...Object.keys(byStatus), ...Object.keys(seen.itemsByStatus)])) {
      if ((byStatus[k] ?? 0) !== (seen.itemsByStatus[k] ?? 0)) {
        emit('BOARD', 'board', `${k}: ${seen.itemsByStatus[k] ?? 0} → ${byStatus[k] ?? 0}`);
      }
    }
  }
  seen.itemsByStatus = byStatus;

  // Ticker
  const ticker = snap.ticker ?? {};
  const tState = ticker.state ?? (ticker.stopped ? 'stopped' : 'running');
  if (tState !== seen.tickerState) {
    emit('TICKER', 'ticker', `state ${seen.tickerState ?? 'none'} → ${tState}`);
    seen.tickerState = tState;
  }
  const tCommits = ticker.totalCommits ?? 0;
  if (tCommits !== seen.tickerCommits) {
    emit('TICKER', 'ticker', `commits ${seen.tickerCommits} → ${tCommits}`);
    seen.tickerCommits = tCommits;
  }
  const lastOutcome = ticker.lastOutcome?.status;
  if (lastOutcome && lastOutcome !== seen.tickerLastOutcome) {
    const path = ticker.lastOutcome.editedPaths?.[0] ?? '';
    const sid = ticker.lastOutcome.sessionID?.slice(-8) ?? '';
    emit('TICKER', 'ticker', `lastOutcome=${lastOutcome} sid=${sid} path=${path}`);
    seen.tickerLastOutcome = lastOutcome;
  }

  // ─── Per-session probes (in parallel) ─────────────────────────────
  const meta = snap.meta ?? {};
  const teamSids = meta.sessionIDs ?? [];
  const probeTargets = [];
  teamSids.forEach((sid, i) => probeTargets.push({ sid, label: `ses[${i}]` }));
  if (meta.auditorSessionID) probeTargets.push({ sid: meta.auditorSessionID, label: 'audit' });
  if (meta.criticSessionID) probeTargets.push({ sid: meta.criticSessionID, label: 'critic' });
  if (meta.verifierSessionID) probeTargets.push({ sid: meta.verifierSessionID, label: 'verify' });

  const probes = await Promise.all(
    probeTargets.map((p) => probeSession(p.sid, p.label, meta.workspace ?? '')),
  );

  for (const p of probes) {
    const prevMsg = seen.sessionMsgCount[p.sid] ?? 0;
    const prevCompleted = seen.sessionCompleted[p.sid] ?? 0;
    const prevTools = seen.sessionTools[p.sid] ?? {};

    if (p.msgCount !== prevMsg) {
      emit('MSGS', p.label, `msgs ${prevMsg} → ${p.msgCount}`);
      seen.sessionMsgCount[p.sid] = p.msgCount;
    }
    if (p.completedAssistants !== prevCompleted) {
      emit('MSGS', p.label, `completed-assistants ${prevCompleted} → ${p.completedAssistants}`);
      seen.sessionCompleted[p.sid] = p.completedAssistants;
    }
    for (const tool of new Set([...Object.keys(p.toolCalls), ...Object.keys(prevTools)])) {
      const cur = p.toolCalls[tool] ?? 0;
      const prev = prevTools[tool] ?? 0;
      if (cur !== prev) {
        emit('TOOL', p.label, `${tool} ${prev} → ${cur}`);
      }
    }
    seen.sessionTools[p.sid] = p.toolCalls;
    if (p.error && p.error !== seen.sessionError[p.sid]) {
      const errSummary =
        typeof p.error === 'object'
          ? `${p.error.name ?? '?'}: ${(p.error.message ?? '').slice(0, 80)}`
          : String(p.error).slice(0, 80);
      emit('ERROR', p.label, errSummary);
      seen.sessionError[p.sid] = p.error;
    }
  }

  return true;
}

async function main() {
  emit('STATUS', 'run', `observer armed for ${RUN_ID} · poll=${POLL_MS / 1000}s · cap=${HARD_CAP_SEC}s`);
  while (true) {
    if (elapsed() > HARD_CAP_SEC) {
      emit('STATUS', 'run', `observer hit hard cap @ ${elapsed()}s`);
      break;
    }
    try {
      await poll();
    } catch (err) {
      emit('ERROR', 'run', `poll threw: ${err.message?.slice(0, 100)}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  emit('ERROR', 'run', `observer crashed: ${err.message?.slice(0, 100)}`);
  process.exit(1);
});
