// HARDENING_PLAN.md#C11 — transform.ts split.
//
// Diff parsers for the inspector's history-drawer + cards-view file
// list. opencode's /diff endpoint returns one entry per file (session-
// aggregate, not per-turn — see memory/reference_opencode_diff_endpoint.md);
// these helpers translate the unified-diff strings into the structured
// shape the DiffView component renders.

import type { DiffData, DiffHunk, DiffLine } from '../../types';

// Parses opencode's unified-diff string into the shape the existing DiffView
// component renders. Tolerates the "Index:" + "====" preamble that opencode
// emits before the standard --- / +++ / @@ hunks.
export function parseUnifiedDiff(file: string, patch: string): DiffData {
  const lines = patch.split(/\r?\n/);
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of lines) {
    if (raw.startsWith('@@')) {
      // @@ -oldStart,oldCount +newStart,newCount @@
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (!match) continue;
      oldLine = parseInt(match[1], 10);
      newLine = parseInt(match[2], 10);
      current = { header: raw, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('Index:') || raw.startsWith('===')) {
      continue;
    }
    if (raw.startsWith('\\')) {
      // "\ No newline at end of file" — skip
      continue;
    }
    const prefix = raw[0];
    const text = raw.slice(1);
    let entry: DiffLine;
    if (prefix === '+') {
      entry = { type: 'add', num: newLine, text };
      newLine += 1;
      additions += 1;
    } else if (prefix === '-') {
      entry = { type: 'remove', num: oldLine, text };
      oldLine += 1;
      deletions += 1;
    } else {
      // space-prefixed context line, or an empty line inside a hunk (treat as context)
      entry = { type: 'context', num: newLine, text };
      oldLine += 1;
      newLine += 1;
    }
    current.lines.push(entry);
  }

  return { file, additions, deletions, hunks };
}

// Opencode's diff endpoint returns the session-aggregate delta per file, not
// per-turn. To scope a turn, filter the aggregate to just the files that turn's
// patch part named. Diff *text* is still session-wide for those files — call
// out that caveat in the UI.
export function parseSessionDiffs(
  diffs: Array<{ file: string; patch: string }>,
): DiffData[] {
  return diffs.map((d) => parseUnifiedDiff(d.file, d.patch));
}

export function filterDiffsForTurn(
  allDiffs: DiffData[],
  turnFiles: string[],
): DiffData[] {
  if (turnFiles.length === 0) return [];
  const set = new Set(turnFiles);
  return allDiffs.filter((d) => set.has(d.file));
}
