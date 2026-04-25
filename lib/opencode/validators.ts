// Per-endpoint shape validators for opencode HTTP responses.
// See ./runtime-shape.ts for the framework.
//
// Each validator declares the 1–3 critical fields the call site
// depends on. If opencode renames or drops one of these, the
// `parseOpencodeJSON` boundary throws with a clear context string
// instead of letting a wrong-shape value propagate into orchestrator
// code where the failure looks unrelated.

import { hasFields, isArrayOf } from './runtime-shape';
import type {
  OpencodeMessage,
  OpencodeMessageInfo,
  OpencodeProject,
  OpencodeSession,
} from './types';

// OpencodeSession — the picker reads `.id`, `.title`, `.time.updated`.
// Validate `id` + `time` (objects flatten unevenly across opencode
// versions; the field is required either way).
export const isOpencodeSession = hasFields<OpencodeSession>('id', 'time');
export const isOpencodeSessionArray = isArrayOf(isOpencodeSession);

// OpencodeMessage = { info, parts }. Both required by every reader.
export const isOpencodeMessage = hasFields<OpencodeMessage>('info', 'parts');
export const isOpencodeMessageArray = isArrayOf(isOpencodeMessage);

// OpencodeMessageInfo (used standalone in /session/{id} too) — we
// always read `id` and `role` at minimum.
export const isOpencodeMessageInfo = hasFields<OpencodeMessageInfo>('id', 'role');

// OpencodeProject — `id` and `worktree` drive our project enumeration
// in getAllSessions().
export const isOpencodeProject = hasFields<OpencodeProject>('id', 'worktree');
export const isOpencodeProjectArray = isArrayOf(isOpencodeProject);

// Diff response — flat array of `{ file, patch }` objects per
// memory/reference_opencode_diff_endpoint.md.
export interface OpencodeDiffEntry {
  file: string;
  patch: string;
}
export const isOpencodeDiffEntry = hasFields<OpencodeDiffEntry>('file', 'patch');
export const isOpencodeDiffArray = isArrayOf(isOpencodeDiffEntry);
