import 'server-only';

 import { appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RunRetro } from './types';

export interface MemoryEntry {
  ts: number;
  runId: string;
  pattern: string;
  commits: number;
  lessons: Array<{ tag: string; text: string }>;
}

const MAX_BYTES = 1_048_576;
const KEEP_RATIO = 0.5;

function memoryPath(workspace: string): string {
  const resolved = resolve(workspace);
  return join(resolved, '.swarm-memory.jsonl');
}

function parseLines(text: string): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines — the JSONL is append-only so a partial write
      // or crash can leave truncated lines. Better to lose one line than
      // to lose the entire file's history.
    }
  }
  return out;
}

export async function appendMemoryEntry(
  workspace: string,
  entry: MemoryEntry,
): Promise<void> {
  const path = memoryPath(workspace);
  const line = JSON.stringify(entry) + '\n';
  await appendFile(path, line, 'utf8');
  await pruneIfOverSize(path);
}

export async function readRecentMemory(
  workspace: string,
  n = 5,
): Promise<MemoryEntry[]> {
  const path = memoryPath(workspace);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const entries = parseLines(text);
  return entries.slice(-n);
}

export function renderMemoryForSeed(entries: MemoryEntry[]): string {
  if (entries.length === 0) return '';
  const lines = entries.map((e, i) => {
    const lessons = e.lessons
      .map((l) => `  - [${l.tag}] ${l.text}`)
      .join('\n');
    return `Run ${i + 1} (${e.pattern}, ${e.commits} commits):\n${lessons}`;
  });
  return `Lessons from previous runs:\n${lines.join('\n\n')}`;
}

export function entryFromRetro(retro: RunRetro): MemoryEntry {
  return {
    ts: retro.timeline.end,
    runId: retro.swarmRunID,
    pattern: '',
    commits: retro.artifactGraph.commits.length,
    lessons: retro.lessons,
  };
}

export async function writeDissentLesson(
  workspace: string,
  swarmRunID: string,
  pattern: string,
  text: string,
): Promise<void> {
  await appendMemoryEntry(workspace, {
    ts: Date.now(),
    runId: swarmRunID,
    pattern,
    commits: 0,
    lessons: [{ tag: 'dissent', text: text.slice(0, 200) }],
  });
}

async function pruneIfOverSize(path: string): Promise<void> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return;
  }
  if (size <= MAX_BYTES) return;
  const text = await readFile(path, 'utf8');
  const entries = parseLines(text);
  const keep = Math.max(1, Math.floor(entries.length * KEEP_RATIO));
  const pruned = entries.slice(-keep);
  await writeFile(path, pruned.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}