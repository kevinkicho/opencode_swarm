#!/usr/bin/env node
// HARDENING_PLAN.md#D7 — capture opencode JSON fixtures.
//
// Walks recent runs in .opencode_swarm/runs/, fetches messages from
// each session via the live opencode at :4097, picks representative
// payloads for the schema-drift firewall, sanitizes user paths, and
// writes them to lib/opencode/__fixtures__/.
//
// We want one fixture per "shape" listed in the README:
//   - planner-tier-1.json          (a sweep with ≥3 todos)
//   - worker-with-tools.json       (worker turn w/ tool + patch parts)
//   - worker-text-only-skip.json   (worker that legitimately said "skip:")
//   - worker-pseudo-tool-text.json (Q42 reproducer — text masquerading as tools)
//   - critic-approved.json         (verdict reply)
//   - council-round.json           (deliberation round drafts)
//
// Sanitization: Windows path prefixes like
// "C:\\Users\\kevin\\Workspace\\..." → "/USER" so the fixtures are
// reproducible across machines.

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const RUNS_DIR = join(ROOT, '.opencode_swarm', 'runs');
const FIX_DIR = join(ROOT, 'lib', 'opencode', '__fixtures__');
mkdirSync(FIX_DIR, { recursive: true });

if (!process.env.OPENCODE_BASIC_USER || !process.env.OPENCODE_BASIC_PASS) {
  console.error('Set OPENCODE_BASIC_USER + OPENCODE_BASIC_PASS first (source .env).');
  process.exit(1);
}
const auth =
  'Basic ' +
  Buffer.from(
    `${process.env.OPENCODE_BASIC_USER}:${process.env.OPENCODE_BASIC_PASS}`,
  ).toString('base64');

// WSL2 → Windows host gateway. The script runs from WSL where 127.0.0.1
// won't reach the Windows opencode listener; the default gateway does.
let opencodeHost = process.env.OPENCODE_URL;
if (!opencodeHost) {
  const route = await import('node:child_process').then((m) =>
    new Promise((resolve, reject) =>
      m.exec('ip route show', (err, stdout) => (err ? reject(err) : resolve(stdout))),
    ),
  );
  const m = /default via (\S+)/.exec(route);
  opencodeHost = m ? `http://${m[1]}:4097` : 'http://127.0.0.1:4097';
}

async function fetchMessages(sessionID, workspace) {
  const url = new URL(`${opencodeHost}/session/${sessionID}/message`);
  url.searchParams.set('directory', workspace);
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${sessionID}`);
  return res.json();
}

function sanitize(raw) {
  // Replace Windows-style and POSIX user-home paths with /USER. Strip
  // model-id strings only when they leak environment specifics; keep
  // provider/model fields since they're load-bearing for transform.
  return JSON.parse(
    JSON.stringify(raw)
      .replace(/C:\\\\Users\\\\[^\\\\]+/gi, '/USER')
      .replace(/C:\\Users\\[^\\]+/gi, '/USER')
      .replace(/\/mnt\/c\/Users\/[^/]+/g, '/USER')
      .replace(/\/home\/[^/]+/g, '/USER'),
  );
}

function listRuns() {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter((d) => d.startsWith('run_'))
    .map((d) => {
      const meta = JSON.parse(readFileSync(join(RUNS_DIR, d, 'meta.json'), 'utf8'));
      return meta;
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

// Match a message to one of the wanted-fixture shapes. Returns the
// fixture name if matched (so the caller saves under that name), null
// otherwise.
function classifyMessage(meta, msg, role) {
  const parts = msg.parts || [];
  const types = new Set(parts.map((p) => p.type));
  const hasTool = types.has('tool');
  const hasPatch = types.has('patch');
  const text = parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text || '')
    .join('');
  if (msg.info?.role !== 'assistant') return null;

  // worker-pseudo-tool-text: text-only, no tool/patch, contains
  // pseudo-XML tool markup. Q42 reproducer.
  if (
    !hasTool &&
    !hasPatch &&
    /<tool[> ]|<arg_key>|<\/tool>/.test(text)
  ) {
    return 'worker-pseudo-tool-text';
  }
  // worker-text-only-skip: starts with "skip:" prefix, no tool/patch.
  if (!hasTool && !hasPatch && /^\s*skip\s*:/i.test(text)) {
    return 'worker-text-only-skip';
  }
  // worker-with-tools: has tool AND/OR patch parts.
  if (hasTool || hasPatch) {
    return 'worker-with-tools';
  }
  // critic-approved: critic-loop or critic gate session, verdict reply.
  if (
    /VERDICT:\s*(SUBSTANTIVE|APPROVED|VERIFIED)/i.test(text) &&
    role === 'critic'
  ) {
    return 'critic-approved';
  }
  // planner-tier-1: planner sweep reply with todowrite-like markup.
  if (
    /(todowrite|<todos>|^\s*\d+\.\s+\w+)/im.test(text) &&
    role === 'planner'
  ) {
    return 'planner-tier-1';
  }
  // council-round: longer prose without verdict/skip markers.
  if (text.length > 400 && role === 'council') {
    return 'council-round';
  }
  return null;
}

function rolePerSession(meta, idx) {
  // Best-effort role label per pattern + slot.
  if (meta.pattern === 'orchestrator-worker' && idx === 0) return 'orchestrator';
  if (meta.pattern === 'orchestrator-worker') return 'worker';
  if (meta.pattern === 'critic-loop' && idx === 0) return 'worker';
  if (meta.pattern === 'critic-loop' && idx === 1) return 'critic';
  if (meta.pattern === 'council') return 'council';
  if (meta.pattern === 'blackboard' && idx === 0) return 'planner';
  if (meta.pattern === 'blackboard') return 'worker';
  if (meta.pattern === 'role-differentiated') return 'worker';
  return 'worker';
}

const wanted = new Set([
  'planner-tier-1',
  'worker-with-tools',
  'worker-text-only-skip',
  'worker-pseudo-tool-text',
  'critic-approved',
  'council-round',
]);
const captured = new Set();

const runs = listRuns();
console.log(`Scanning ${runs.length} runs for fixtures…`);

outer: for (const meta of runs) {
  if (captured.size === wanted.size) break;
  for (let i = 0; i < meta.sessionIDs.length; i++) {
    if (captured.size === wanted.size) break outer;
    const sid = meta.sessionIDs[i];
    const role = rolePerSession(meta, i);
    let messages;
    try {
      messages = await fetchMessages(sid, meta.workspace);
    } catch (err) {
      // Session not found / opencode pruned — skip
      continue;
    }
    for (const msg of messages) {
      const name = classifyMessage(meta, msg, role);
      if (!name || captured.has(name) || !wanted.has(name)) continue;
      const out = join(FIX_DIR, `${name}.json`);
      const sanitized = sanitize({
        captureMeta: {
          source: 'scripts/_capture-opencode-fixtures.mjs',
          pattern: meta.pattern,
          role,
          capturedAt: Date.now(),
        },
        message: msg,
      });
      writeFileSync(out, JSON.stringify(sanitized, null, 2), 'utf8');
      captured.add(name);
      console.log(`  ✓ ${name}.json (from run ${meta.swarmRunID}, session #${i})`);
    }
  }
}

const missing = [...wanted].filter((n) => !captured.has(n));
if (missing.length > 0) {
  console.log(`\nMissing (no matching real message yet): ${missing.join(', ')}`);
  console.log('These can be added by hand later — the test loop reads whatever ships.');
} else {
  console.log('\nAll 6 fixtures captured.');
}
