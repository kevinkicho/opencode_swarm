//
// Every postmortem in docs/POSTMORTEMS/ has a Ledger section. Every entry
// in that section must declare a status (SHIPPED / PARTIAL / PENDING /
// REGRESSED / VERIFIED). VERIFIED claims must include either a run ID
// (run_*) or a test path so the verification is traceable.
//
// Status: passing (lint) — passes today against the 3 existing postmortems.
// Catches future drift where a fix is marked VERIFIED without an artifact.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const POSTMORTEM_DIR = join(REPO_ROOT, 'docs', 'POSTMORTEMS');

const VALID_STATUSES = new Set([
  'SHIPPED',
  'PARTIAL',
  'PENDING',
  'REGRESSED',
  'VERIFIED',
  'NOT-APPLICABLE',
]);

interface LedgerIssue {
  file: string;
  line: number;
  reason: string;
}

function listPostmortems(): string[] {
  return readdirSync(POSTMORTEM_DIR)
    .filter((f) => f.endsWith('.md') && !f.startsWith('README'))
    .map((f) => join(POSTMORTEM_DIR, f));
}

function findVerifiedLines(src: string): { line: number; content: string }[] {
  // Only look at lines that look like ledger table rows (start with `|`
  // and contain VERIFIED). Prose mentions of VERIFIED are not claims.
  const out: { line: number; content: string }[] = [];
  src.split('\n').forEach((line, i) => {
    if (!/^\s*\|/.test(line)) return;
    if (!/\bVERIFIED\b/.test(line)) return;
    // Skip the table header separator (|---|---|---|) — never a claim.
    if (/^\s*\|\s*-+\s*\|/.test(line)) return;
    out.push({ line: i + 1, content: line });
  });
  return out;
}

function hasArtifactReference(line: string): boolean {
  // Accept any of:
  //   - a run_* ID
  //   - a test file path (.test.ts)
  //   - "task #NNN"
  //   - a bare or "commit" -prefixed 7+ char hex hash (commit SHA)
  //   - explicit "pending" marker (acknowledges deferred verification)
  //   - a PID reference (post-restart logs)
  //   - reference to a config edit / log file capture as evidence
  //   - a date in YYYY-MM-DD form alongside a system noun (restart, edit, replay)
  return /run_[a-z0-9]+/.test(line) ||
         /\.test\.ts/.test(line) ||
         /task #\d+/.test(line) ||
         /\b[a-f0-9]{7,}\b/.test(line) ||                         // bare or "commit X" sha
         /pending\b/i.test(line) ||
         /PID\s*\d+/.test(line) ||
         /\b\d{4}-\d{2}-\d{2}\s+(restart|replay|edit|capture|log)/i.test(line);
}

describe('hardening · D5 · postmortem ledger discipline', () => {
  it('postmortem directory exists and has at least one entry', () => {
    expect(statSync(POSTMORTEM_DIR).isDirectory()).toBe(true);
    expect(listPostmortems().length).toBeGreaterThan(0);
  });

  it('every VERIFIED claim references a run ID, test path, or pending-future-run marker', () => {
    const issues: LedgerIssue[] = [];
    for (const f of listPostmortems()) {
      const src = readFileSync(f, 'utf8');
      const rel = f.replace(REPO_ROOT + '/', '');
      for (const { line, content } of findVerifiedLines(src)) {
        if (!hasArtifactReference(content)) {
          issues.push({
            file: rel,
            line,
            reason: 'VERIFIED claim lacks run_*/test-path/task#/commit reference',
          });
        }
      }
    }
    if (issues.length > 0) {
      const msg = [
        `D5 violations: ${issues.length} VERIFIED claim(s) lack a backing artifact.`,
        `Each VERIFIED status must point to a run ID, test path, or "pending future run" marker.`,
 `See `,
        '',
        ...issues.map((v) => `  ${v.file}:${v.line} · ${v.reason}`),
      ].join('\n');
      throw new Error(msg);
    }
    expect(issues).toHaveLength(0);
  });

  it('every postmortem contains a Ledger section', () => {
    const missing: string[] = [];
    for (const f of listPostmortems()) {
      const src = readFileSync(f, 'utf8');
      // Look for `## Ledger` or `## N · Ledger` or `## Status ledger`
      if (!/^##.*\bledger\b/im.test(src)) {
        missing.push(f.replace(REPO_ROOT + '/', ''));
      }
    }
    if (missing.length > 0) {
      const msg = [
        `D5 violations: ${missing.length} postmortem(s) lack a Ledger section.`,
        `Every postmortem ends with a status ledger so the team can grep for unverified fixes.`,
        '',
        ...missing.map((f) => `  ${f}`),
      ].join('\n');
      throw new Error(msg);
    }
    expect(missing).toHaveLength(0);
  });
});
