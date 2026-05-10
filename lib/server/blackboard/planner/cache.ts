//
// Planner prompt cache — avoids re-reading README and lessons from disk
// on every sweep. The README (5-25 KB) and lessons (up to 3.2 KB) don't
// change during a single run's lifetime. Caching them saves ~20% of
// planner prompt content per re-sweep (after the first sweep).
//
// MC simulation: planner consumes 81% of tokens. Every byte of cached
// prompt content directly increases output per dollar.
//
// globalThis-keyed so it survives HMR within a single process lifetime.

import 'server-only';

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const CACHE_TTL_MS = 10 * 60_000; // 10 min — single run duration

interface CacheEntry<T> {
  value: T;
  at: number;
}

const README_KEY = Symbol.for('opencode_swarm.planner.readmeCache');
const LESSONS_KEY = Symbol.for('opencode_swarm.planner.lessonsCache');

function cacheMap<T>(key: symbol): Map<string, CacheEntry<T>> {
  const g = globalThis as Record<symbol, Map<string, CacheEntry<T>>>;
  if (!g[key]) g[key] = new Map();
  return g[key]!;
}

// Convert Windows path to WSL mount for Node reads under WSL.
function toNodeReadable(p: string): string {
  const m = p.match(/^([A-Za-z]):[/\\](.*)$/);
  if (!m) return p;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

const README_MAX_BYTES = 32 * 1024;

export async function getCachedReadme(workspace: string): Promise<string | null> {
  const map = cacheMap<string | null>(README_KEY);
  const entry = map.get(workspace);
  if (entry && Date.now() - entry.at < CACHE_TTL_MS) {
    return entry.value;
  }

  const root = toNodeReadable(workspace);
  const candidates = ['README.md', 'readme.md', 'README.MD', 'Readme.md'];
  let content: string | null = null;
  for (const name of candidates) {
    try {
      const raw = await readFile(path.join(root, name), 'utf8');
      content = raw.length > README_MAX_BYTES
        ? raw.slice(0, README_MAX_BYTES) + '\n\n[… README truncated at 32 KB — rest omitted]'
        : raw;
      break;
    } catch { /* next */ }
  }
  map.set(workspace, { value: content, at: Date.now() });
  return content;
}

export function getCachedLessons(workspace: string): string | null {
  const map = cacheMap<string>(LESSONS_KEY);
  const entry = map.get(workspace);
  if (entry && Date.now() - entry.at < CACHE_TTL_MS) {
    return entry.value || null;
  }
  return null;
}

export function setCachedLessons(workspace: string, content: string): void {
  const map = cacheMap<string>(LESSONS_KEY);
  map.set(workspace, { value: content, at: Date.now() });
}

export function invalidatePlannerCache(workspace: string): void {
  cacheMap(README_KEY).delete(workspace);
  cacheMap(LESSONS_KEY).delete(workspace);
}
