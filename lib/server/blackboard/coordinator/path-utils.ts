// Path / file-content helpers shared across the coordinator's modules.
//
// Extracted from coordinator.ts in #107 phase 2. These are pure (no
// side effects beyond fs.readFile in sha7) so each is easy to unit-test
// in isolation, and they're used both by dispatch (for CAS drift +
// path-overlap collision avoidance) and by the picker (for stigmergy
// scoring).

import 'server-only';

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { OpencodeMessage } from '../../../opencode/types';

// Same pattern as planner.ts::sha7 — 7-char git-short SHA1 of file contents.
export async function sha7(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  return createHash('sha1').update(buf).digest('hex').slice(0, 7);
}

// File-path-ish tokens inside a todo's content. Used to detect overlap
// with an in-progress item's content so two sessions don't trample each
// other's files. Matches: dir-ish (src/foo/bar), file-ish with common
// extensions, and bare basenames ≥4 chars with an extension. Tokens
// under 4 chars are skipped — "ts" / "js" would be noise.
const PATH_TOKEN_RE = /[a-zA-Z_][\w.-]*(?:\/[\w.-]+)+\/?|\b\w{4,}\.(?:ts|tsx|js|jsx|py|go|rs|md|css|html|json|yaml|yml|toml)\b/g;

export function extractPathTokens(content: string): Set<string> {
  const out = new Set<string>();
  const matches = content.match(PATH_TOKEN_RE) ?? [];
  for (const m of matches) out.add(m.replace(/\\/g, '/').replace(/\/$/, ''));
  return out;
}

export function pathOverlaps(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      if (x.startsWith(y + '/')) return true; // y is ancestor of x
      if (y.startsWith(x + '/')) return true; // x is ancestor of y
    }
  }
  return false;
}

// Which files did the turn edit? `patch` parts carry `files: string[]`
// (one part per turn that committed edits — see lib/opencode/types.ts). We
// union across every patch part in the scoped messages, so a turn that
// touches the same file twice produces one entry.
export function extractEditedPaths(
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
export function extractWorkerAssistantText(
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
export function relativizeToWorkspace(workspace: string, p: string): string {
  const rel = path.relative(workspace, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return p.replace(/\\/g, '/');
  }
  return rel.replace(/\\/g, '/');
}
