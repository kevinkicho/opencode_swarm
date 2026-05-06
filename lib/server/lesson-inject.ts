// Lesson injection for pattern-specific prompt builders.
//
// Reads recent memory entries (from the JSONL memory store) and formats
// them as a `## Lessons from previous runs` block suitable for prepending
// to any pattern's intro directive. Each pattern coordinator calls this
// before posting its intro prompt.
//
// The function is intentionally async (reads from the filesystem) so
// callers should await it before constructing the final prompt string.
//
// Companion: `renderMemoryForSeed` in memory-store.ts formats entries.
// This module wraps the read+render pair with a size cap so the lesson
// block stays under ~800 tokens in the directive.

import 'server-only';

import { readRecentMemory, renderMemoryForSeed } from './memory/memory-store';

const MAX_LESSONS_BYTES = 3200;

export async function buildLessonsBlock(workspace: string): Promise<string> {
  const entries = await readRecentMemory(workspace);
  if (entries.length === 0) return '';
  const rendered = renderMemoryForSeed(entries);
  if (!rendered) return '';
  if (rendered.length > MAX_LESSONS_BYTES) {
    return rendered.slice(0, MAX_LESSONS_BYTES) + '\n...(truncated)';
  }
  return rendered;
}