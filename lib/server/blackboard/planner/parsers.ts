// HARDENING_PLAN.md#C12 — planner.ts split.
//
// Wire-protocol parsers for the planner's todowrite output. opencode's
// todowrite tool only accepts {content, status, priority} — to thread
// extra signal (verification opt-in, role affinity, file scope, criterion
// flag, source-draft attribution, role-clarification side channel) we
// overload the content field with leading `[tag]` prefixes. The strip-*
// helpers peel the prefix off; latestTodosFrom orchestrates the strip
// chain and returns structured RawTodo records the sweep loop consumes.
//
// Each strip helper is exported (also used by `scripts/_parser_smoke.mjs`,
// which can't pull in server-only deps) and has a corresponding case in
// planner-parsers.test.ts (44 cases). Keep them pure — no I/O, no
// side effects — so the sweep loop can call them in tight loops without
// extra complexity.

import 'server-only';

import type { OpencodeMessage } from '../../../opencode/types';

export interface RawTodo {
  content: string;
  status?: string;
  priority?: string;
  // Computed by latestTodosFrom — not on the wire. True when the
  // planner tagged this todo's content with a leading `[verify]`
  // prefix, indicating the todo claims a user-observable outcome
  // that merits Playwright verification after commit. See
  // buildPlannerPrompt + the insert path in runPlannerSweep.
  requiresVerification?: boolean;
  // Computed by latestTodosFrom from a leading `[role:<name>]`
  // prefix. Normalized role name (kebab, lowercase, ≤ 24 chars).
  // Undefined when no prefix or on self-organizing runs.
  preferredRole?: string;
  // Computed by latestTodosFrom from a leading `[files:a,b]`
  // prefix. Capped at 2 paths. Undefined when no prefix.
  expectedFiles?: string[];
  // Computed by latestTodosFrom from a leading `[criterion]`
  // prefix. Routes the entry to insertBoardItem with kind='criterion'
  // instead of kind='todo'. Other flags (verify/role/files) are
  // dropped when this is true — criteria are auditor-verdict targets,
  // not worker-dispatch targets.
  isCriterion?: boolean;
  // PATTERN_DESIGN/deliberate-execute.md I2 — synthesis traceability.
  // Computed by latestTodosFrom from a `[from:1,3]` content prefix the
  // synthesizer emits during phase 2. 1-based, deduped, max 8 entries.
  // Undefined for non-deliberate-execute paths and for synthesis runs
  // where the model didn't tag.
  sourceDrafts?: number[];
  // PATTERN_DESIGN/role-differentiated.md I3 — per-sweep role-intro
  // append. When the planner emits `[rolenote:<role>] <text>`, the
  // entry is NOT a todo — it's a side-channel clarification message
  // that runPlannerSweep routes to the matching role's session and
  // does not insert on the board. Other tags (verify/role/files/from)
  // become irrelevant for these entries.
  roleNote?: string;
}

// Strips the `[verify]` opt-in prefix from a todo's content and
// reports whether it was present. The prefix is the wire protocol
// the planner uses to flag UX-claiming todos (opencode's todowrite
// tool only supports content/status/priority, so we overload
// content rather than invent a new tool). Case-insensitive; allows
// variants like `[verify]`, `[VERIFY]`, `[Verify]`.
const VERIFY_TAG_RE = /^\s*\[verify\]\s*/i;

// Exported for `scripts/_parser_smoke.mjs` — pure function, safe to
// import from a smoke script that doesn't want to pull in the rest of
// the planner's server-only dependency graph.
export function stripVerifyTag(content: string): {
  content: string;
  requiresVerification: boolean;
} {
  const m = VERIFY_TAG_RE.exec(content);
  if (!m) return { content, requiresVerification: false };
  return {
    content: content.slice(m[0].length).trim(),
    requiresVerification: true,
  };
}

// Strips the `[role:<name>]` opt-in prefix from a todo's content and
// returns the resolved preferredRole. Same wire-protocol rationale as
// stripVerifyTag — overload the content field since todowrite has no
// side channel. Role names are normalized to the same shape as
// role-differentiated.ts::normalizeRoleName (lowercase kebab, alnum +
// hyphen only, ≤ 24 chars) so a typo like `[role: Tester ]` still
// matches `tester` downstream. Applies idempotently after
// stripVerifyTag so `[verify] [role:tester] ...` composes.
const ROLE_TAG_RE = /^\s*\[role:\s*([a-z0-9][a-z0-9\s\-_]{0,31})\s*\]\s*/i;

// Exported for `scripts/_parser_smoke.mjs` — same rationale as
// stripVerifyTag.
export function stripRoleTag(content: string): {
  content: string;
  preferredRole: string | undefined;
} {
  const m = ROLE_TAG_RE.exec(content);
  if (!m) return { content, preferredRole: undefined };
  const raw = m[1].toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  if (!normalized) return { content: content.slice(m[0].length).trim(), preferredRole: undefined };
  return {
    content: content.slice(m[0].length).trim(),
    preferredRole: normalized,
  };
}

// Strips the `[files:<path>,<path>]` prefix and returns the expected
// file scope for the todo (2026-04-24, declared-roles alignment). Same
// wire-protocol rationale as stripVerifyTag / stripRoleTag — overload
// the content field because todowrite only accepts content/status/
// priority. Cap at 2 paths per the blackboard spec (smaller = smaller
// contention surface at claim time). Extra paths are silently dropped
// rather than rejecting the whole todo. Empty list → undefined so
// consumers don't distinguish "tag absent" from "tag present but empty."
const FILES_TAG_RE = /^\s*\[files:\s*([^\]]*)\s*\]\s*/i;
const EXPECTED_FILES_MAX = 2;
export function stripFilesTag(content: string): {
  content: string;
  expectedFiles: string[] | undefined;
} {
  const m = FILES_TAG_RE.exec(content);
  if (!m) return { content, expectedFiles: undefined };
  const paths = m[1]
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .slice(0, EXPECTED_FILES_MAX);
  const stripped = content.slice(m[0].length).trim();
  if (paths.length === 0) {
    return { content: stripped, expectedFiles: undefined };
  }
  return { content: stripped, expectedFiles: paths };
}

// Strips the `[rolenote:<name>]` prefix — per-sweep role-intro append
// (PATTERN_DESIGN/role-differentiated.md I3). Returns the role name on
// match (normalized like stripRoleTag); the consumer treats the entry
// as a side-channel clarification rather than a todo. Same kebab/length
// normalization so a typo like `[rolenote: Tester ]` still routes to
// `tester`. Empty/unknown role → caller treats as a normal todo.
const ROLE_NOTE_TAG_RE = /^\s*\[rolenote:\s*([a-z0-9][a-z0-9\s\-_]{0,31})\s*\]\s*/i;
export function stripRoleNoteTag(content: string): {
  content: string;
  roleNote: string | undefined;
} {
  const m = ROLE_NOTE_TAG_RE.exec(content);
  if (!m) return { content, roleNote: undefined };
  const raw = m[1].toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  if (!normalized) {
    return { content: content.slice(m[0].length).trim(), roleNote: undefined };
  }
  return {
    content: content.slice(m[0].length).trim(),
    roleNote: normalized,
  };
}

// Strips the `[from:1,3]` prefix — synthesis traceability for
// deliberate-execute (PATTERN_DESIGN/deliberate-execute.md I2). Source
// indices are 1-based (matches "Draft from member 1" labels in the
// synthesizer's prompt input). Caps at 8 entries to bound storage and
// rejects non-positive integers, so a malformed `[from:0,abc,3]` parses
// as `[3]` rather than failing the whole todo.
const FROM_TAG_RE = /^\s*\[from:\s*([^\]]*)\s*\]\s*/i;
const SOURCE_DRAFTS_MAX = 8;
export function stripFromTag(content: string): {
  content: string;
  sourceDrafts: number[] | undefined;
} {
  const m = FROM_TAG_RE.exec(content);
  if (!m) return { content, sourceDrafts: undefined };
  const seen = new Set<number>();
  for (const tok of m[1].split(',')) {
    const n = parseInt(tok.trim(), 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    seen.add(n);
    if (seen.size >= SOURCE_DRAFTS_MAX) break;
  }
  const stripped = content.slice(m[0].length).trim();
  if (seen.size === 0) {
    return { content: stripped, sourceDrafts: undefined };
  }
  return {
    content: stripped,
    sourceDrafts: [...seen].sort((a, b) => a - b),
  };
}

// Strips the `[criterion]` prefix — marks the todowrite entry as a
// contract acceptance criterion rather than a work todo (2026-04-24
// Stage 2 declared-roles alignment). Criteria land on the board with
// kind='criterion' and the auditor verdicts against them; workers
// never claim or dispatch to them. Free-text content (same shape as
// todos) lets the auditor use natural-language judgment instead of
// machine-verifiable assertions — keeps the planner's hand free to
// author ambitious criteria the ambition ratchet can work toward.
const CRITERION_TAG_RE = /^\s*\[criterion\]\s*/i;
export function stripCriterionTag(content: string): {
  content: string;
  isCriterion: boolean;
} {
  const m = CRITERION_TAG_RE.exec(content);
  if (!m) return { content, isCriterion: false };
  return {
    content: content.slice(m[0].length).trim(),
    isCriterion: true,
  };
}

// Last todowrite among the given message IDs wins. Mirrors
// transform.ts::toRunPlan's "latest call replaces the list" contract, but
// scoped to just the sweep's new messages so a pre-existing todowrite from
// an earlier turn doesn't leak into the board. Exported for reuse by
// other pattern orchestrators that need to extract todowrite-seeded
// work from an arbitrary session turn (e.g. deliberate-execute synthesis).
export function latestTodosFrom(
  messages: OpencodeMessage[],
  scopeMessageIDs: Set<string>,
): { todos: RawTodo[]; messageId: string } | null {
  let latest: { todos: RawTodo[]; messageId: string } | null = null;
  for (const m of messages) {
    if (!scopeMessageIDs.has(m.info.id)) continue;
    for (const part of m.parts) {
      if (part.type !== 'tool' || part.tool !== 'todowrite') continue;
      const state = part.state as { input?: { todos?: unknown } } | undefined;
      const raw = state?.input?.todos;
      if (!Array.isArray(raw)) continue;
      const todos = raw
        .filter(
          (t): t is RawTodo =>
            !!t &&
            typeof t === 'object' &&
            typeof (t as RawTodo).content === 'string' &&
            (t as RawTodo).content.trim().length > 0,
        )
        .map((t) => {
          // Strip in composition order: rolenote → criterion → verify
          // → role → files → from. Rolenote goes first because when
          // present, the entry is a side-channel clarification — every
          // other flag becomes irrelevant (no board insert, no claim,
          // no verifier gate). Criterion is next for the same reason
          // (auditor target, not a worker dispatch). Each stripper
          // re-trims leading whitespace so mixed-order tags are
          // tolerated.
          const afterRoleNote = stripRoleNoteTag(t.content);
          if (afterRoleNote.roleNote) {
            return {
              ...t,
              content: afterRoleNote.content,
              roleNote: afterRoleNote.roleNote,
            };
          }
          const afterCriterion = stripCriterionTag(afterRoleNote.content);
          if (afterCriterion.isCriterion) {
            return {
              ...t,
              content: afterCriterion.content,
              isCriterion: true,
            };
          }
          const afterVerify = stripVerifyTag(afterCriterion.content);
          const afterRole = stripRoleTag(afterVerify.content);
          const afterFiles = stripFilesTag(afterRole.content);
          const afterFrom = stripFromTag(afterFiles.content);
          return {
            ...t,
            content: afterFrom.content,
            requiresVerification: afterVerify.requiresVerification,
            preferredRole: afterRole.preferredRole,
            expectedFiles: afterFiles.expectedFiles,
            sourceDrafts: afterFrom.sourceDrafts,
          };
        });
      if (todos.length > 0) latest = { todos, messageId: m.info.id };
    }
  }
  return latest;
}
