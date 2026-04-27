#!/usr/bin/env node
// Validation monitor — drives a live swarm run and emits a structured
// event line on stdout per state change. Built for the Monitor tool:
// each emitted line becomes a notification.
//
// Usage:
//   node scripts/_validation_monitor.mjs <swarmRunID> [hardCapSec]
//
// Args:
//   swarmRunID — required. The id returned from POST /api/swarm/run.
//   hardCapSec — optional. Default 900 (15 min). Internal ceiling
//                that overrides the run's own bounds for safety.
//
// Reads dev port from .dev-port. Exits 0 on natural completion,
// 1 on internal failure, 2 on early-bail (e.g. zero-token starvation).
//
// Emit format (every line is a notification):
//   [HH:MM:SS][LEVEL][KIND] payload
//
// LEVEL = INFO | WARN | DONE | BAIL
// KIND  = STATUS | TOKENS | DONE_ITEMS | ERROR | SESSIONS | METRIC | FINAL
//
// Early-bail signals:
//   - 0 tokens after EARLY_BAIL_NO_TOKENS_SEC (default 180s = 3min)
//   - run status === 'error' for > 60s
//   - HTTP 5xx from /snapshot for > 60s
//
// Natural stop:
//   - run status terminal (stale/idle with stopped ticker) AND no
//     activity for STALE_CONFIRM_SEC (default 60s)

import { readFileSync } from 'node:fs';
import process from 'node:process';

const RUN_ID = process.argv[2];
const HARD_CAP_SEC = Number(process.argv[3] ?? 900);
const EARLY_BAIL_NO_TOKENS_SEC = 180;
const STALE_CONFIRM_SEC = 60;
const POLL_INTERVAL_MS = 15_000;

if (!RUN_ID) {
  console.error('usage: node _validation_monitor.mjs <swarmRunID> [hardCapSec]');
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

function ts() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function emit(level, kind, payload) {
  process.stdout.write(`[${ts()}][${level}][${kind}] ${payload}\n`);
}

async function fetchSnapshot() {
  const res = await fetch(`${BASE}/api/swarm/run/${RUN_ID}/snapshot`, {
    cache: 'no-store',
  });
  if (!res.ok) {
    return { error: `HTTP ${res.status}` };
  }
  return res.json();
}

async function fetchRow() {
  // Cross-check via the list endpoint — sometimes /snapshot lags
  // /api/swarm/run because they have different cache layers.
  const res = await fetch(`${BASE}/api/swarm/run`, { cache: 'no-store' });
  if (!res.ok) return null;
  const j = await res.json();
  const runs = j.runs ?? j;
  return runs.find((r) => r.meta?.swarmRunID === RUN_ID) ?? null;
}

const startMs = Date.now();
const seen = {
  status: null,
  tokensTotal: 0,
  doneCount: 0,
  errorCount: 0,
  totalCount: 0,
  cost: 0,
  sessionCount: 0,
};
let firstTokenSec = null;
let lastActivityMs = startMs;
let consecutiveErrorPolls = 0;
let consecutiveTerminalPolls = 0;

function elapsed() {
  return Math.round((Date.now() - startMs) / 1000);
}

async function poll() {
  const snap = await fetchSnapshot();
  const row = await fetchRow();
  const now = Date.now();
  const t = elapsed();

  if (snap?.error) {
    consecutiveErrorPolls++;
    emit('WARN', 'ERROR', `snapshot fetch failed: ${snap.error} (consecutive: ${consecutiveErrorPolls})`);
    if (consecutiveErrorPolls >= 4) {
      emit('BAIL', 'ERROR', `snapshot 5xx for ${consecutiveErrorPolls * POLL_INTERVAL_MS / 1000}s`);
      return 'bail';
    }
    return 'continue';
  }
  consecutiveErrorPolls = 0;

  // ─── Status (from row, falls back to snapshot's run.status) ─────────
  const status = row?.status ?? snap?.run?.status ?? 'unknown';
  if (status !== seen.status) {
    emit('INFO', 'STATUS', `${seen.status ?? 'init'} → ${status} @ ${t}s`);
    seen.status = status;
    lastActivityMs = now;
  }

  // ─── Sessions ────────────────────────────────────────────────────────
  const sessionIDs = snap?.run?.sessionIDs ?? row?.meta?.sessionIDs ?? [];
  if (sessionIDs.length !== seen.sessionCount) {
    emit('INFO', 'SESSIONS', `count=${sessionIDs.length}`);
    seen.sessionCount = sessionIDs.length;
  }

  // ─── Tokens (from row.tokensTotal — sum across sessions) ─────────────
  const tokens = row?.tokensTotal ?? 0;
  if (tokens > seen.tokensTotal) {
    if (firstTokenSec === null) {
      firstTokenSec = t;
      emit('INFO', 'TOKENS', `first tokens @ ${t}s (${tokens} total)`);
    } else {
      const delta = tokens - seen.tokensTotal;
      emit('INFO', 'TOKENS', `+${delta} (${tokens} total) @ ${t}s`);
    }
    seen.tokensTotal = tokens;
    lastActivityMs = now;
  }

  // ─── Cost ────────────────────────────────────────────────────────────
  const cost = row?.costTotal ?? 0;
  if (cost > seen.cost) {
    seen.cost = cost;
  }

  // ─── Board items (ticker patterns) ───────────────────────────────────
  const board = snap?.board ?? { items: [] };
  const items = board.items ?? [];
  const doneCount = items.filter((i) => i.status === 'done').length;
  const errorCount = items.filter((i) => i.status === 'error').length;
  if (doneCount > seen.doneCount) {
    emit('INFO', 'DONE_ITEMS', `+${doneCount - seen.doneCount} (${doneCount}/${items.length}) @ ${t}s`);
    seen.doneCount = doneCount;
    lastActivityMs = now;
  }
  if (errorCount > seen.errorCount) {
    emit('WARN', 'ERROR', `+${errorCount - seen.errorCount} item errors (${errorCount}/${items.length})`);
    seen.errorCount = errorCount;
  }
  seen.totalCount = items.length;

  // ─── Early-bail: zero tokens after threshold ─────────────────────────
  if (firstTokenSec === null && t > EARLY_BAIL_NO_TOKENS_SEC) {
    emit('BAIL', 'TOKENS', `0 tokens after ${t}s — dispatch likely broken; bailing`);
    return 'bail';
  }

  // ─── Terminal-state confirmation ─────────────────────────────────────
  // 'stale' or 'idle' with no activity for STALE_CONFIRM_SEC = done.
  // 'error' for >60s = error-bail.
  const idleSince = Math.round((now - lastActivityMs) / 1000);
  if (status === 'error') {
    consecutiveTerminalPolls++;
    if (consecutiveTerminalPolls >= 4) {
      emit('BAIL', 'ERROR', `status=error sustained for ${consecutiveTerminalPolls * POLL_INTERVAL_MS / 1000}s`);
      return 'bail';
    }
  } else if (status === 'stale' || (status === 'idle' && idleSince > STALE_CONFIRM_SEC)) {
    consecutiveTerminalPolls++;
    if (idleSince > STALE_CONFIRM_SEC) {
      emit('DONE', 'FINAL',
        `terminal state confirmed @ ${t}s · status=${status} · idle=${idleSince}s · tokens=${tokens} · cost=$${cost.toFixed(4)} · done=${doneCount}/${items.length}`,
      );
      return 'done';
    }
  } else {
    consecutiveTerminalPolls = 0;
  }

  // ─── Hard cap ────────────────────────────────────────────────────────
  if (t > HARD_CAP_SEC) {
    emit('WARN', 'FINAL', `hard cap hit @ ${t}s — stopping monitor (run may continue)`);
    return 'cap';
  }

  return 'continue';
}

async function main() {
  emit('INFO', 'STATUS', `monitor armed for ${RUN_ID} · hard-cap ${HARD_CAP_SEC}s · poll ${POLL_INTERVAL_MS / 1000}s`);
  while (true) {
    let result;
    try {
      result = await poll();
    } catch (err) {
      emit('WARN', 'ERROR', `poll threw: ${err.message?.slice(0, 200)}`);
      result = 'continue';
    }
    if (result === 'done') {
      emit('DONE', 'METRIC',
        `summary · firstToken=${firstTokenSec ?? 'never'}s · totalTokens=${seen.tokensTotal} · cost=$${seen.cost.toFixed(4)} · done=${seen.doneCount}/${seen.totalCount} · errors=${seen.errorCount}`,
      );
      process.exit(0);
    }
    if (result === 'bail') {
      emit('BAIL', 'METRIC',
        `summary · firstToken=${firstTokenSec ?? 'never'}s · totalTokens=${seen.tokensTotal} · cost=$${seen.cost.toFixed(4)} · done=${seen.doneCount}/${seen.totalCount} · errors=${seen.errorCount}`,
      );
      process.exit(2);
    }
    if (result === 'cap') {
      emit('WARN', 'METRIC',
        `summary · firstToken=${firstTokenSec ?? 'never'}s · totalTokens=${seen.tokensTotal} · cost=$${seen.cost.toFixed(4)} · done=${seen.doneCount}/${seen.totalCount} · errors=${seen.errorCount}`,
      );
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  emit('BAIL', 'ERROR', `monitor crashed: ${err.message?.slice(0, 200)}`);
  process.exit(1);
});
