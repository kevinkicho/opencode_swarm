// Workspace file tree — STATUS.md heat-tab file-tree task.
//
// GET /api/swarm/run/:swarmRunID/tree
//   → { paths: string[]; truncated: boolean; method: 'git-ls-files' | 'fs-walk' }
//
// Returns relative paths inside the run's workspace, gitignore-aware.
// Powers the heat-rail's "tree" view's optional cold-file overlay so
// the user can see workspace regions the swarm has NOT touched yet
// alongside the hot ones.
//
// Two strategies:
// 1. `git ls-files` (preferred) — already gitignore-aware, fast, only
//    returns tracked files. We use this when the workspace is a git
//    repo, which is the common case for clone-a-repo-then-unleash-
//    agents (project_app_vision memory).
// 2. Recursive fs walk with SLICE_EXCLUDE — fallback for non-git
//    workspaces. Skips dotfiles + node_modules + build outputs +
//    common dep / cache dirs. Capped at WALK_MAX_FILES so a
//    pathologically-large repo doesn't pin the response.
//
// Cache: 30s in-memory by swarmRunID. The workspace doesn't change
// often during a run; cold-file overlay just needs to be reasonably
// fresh, not real-time.

import type { NextRequest } from 'next/server';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { getRun } from '@/lib/server/swarm-registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const execFileP = promisify(execFile);

const WALK_MAX_FILES = 8000;
const CACHE_TTL_MS = 30_000;

const EXCLUDE_DIRS = new Set<string>([
  '.git',
  '.next',
  '.svelte-kit',
  '.turbo',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  'tmp',
  'fixtures',
  '__snapshots__',
  'vendor',
]);

interface CacheEntry {
  paths: string[];
  truncated: boolean;
  method: 'git-ls-files' | 'fs-walk';
  capturedAtMs: number;
}
const cache = new Map<string, CacheEntry>();

async function tryGitLsFiles(workspace: string): Promise<string[] | null> {
  try {
    // -z is null-separated; safer than newline for paths with spaces.
    // Limit to TRACKED files only (no --others) so .gitignored content
    // is excluded by definition. Cached files (staged but ignored)
    // also excluded.
    const { stdout } = await execFileP('git', ['ls-files', '-z'], {
      cwd: workspace,
      maxBuffer: 32 * 1024 * 1024,
    });
    const all = stdout.split('\0').filter(Boolean);
    return all.length > WALK_MAX_FILES ? all.slice(0, WALK_MAX_FILES) : all;
  } catch {
    // Not a git repo, or git not on PATH, or the workspace doesn't
    // exist on this host. Fall through to fs walk.
    return null;
  }
}

async function walkFs(
  rootAbs: string,
  dir: string,
  out: string[],
): Promise<void> {
  if (out.length >= WALK_MAX_FILES) return;
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as import('node:fs').Dirent[];
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= WALK_MAX_FILES) return;
    if (e.name.startsWith('.') || EXCLUDE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walkFs(rootAbs, full, out);
    } else if (e.isFile()) {
      out.push(path.relative(rootAbs, full).replace(/\\/g, '/'));
    }
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { swarmRunID: string } },
): Promise<Response> {
  const meta = await getRun(params.swarmRunID);
  if (!meta) {
    return Response.json({ error: 'swarm run not found' }, { status: 404 });
  }
  if (!meta.workspace) {
    return Response.json(
      { error: 'run has no workspace' },
      { status: 400 },
    );
  }

  const cached = cache.get(params.swarmRunID);
  if (cached && Date.now() - cached.capturedAtMs < CACHE_TTL_MS) {
    return Response.json({
      paths: cached.paths,
      truncated: cached.truncated,
      method: cached.method,
      cached: true,
    });
  }

  // Workspace path is Windows-shaped (C:\...) when opencode runs on
  // Windows. Convert to WSL mount form so fs / git can read it from
  // the Node-side process. Mirrors toNodeReadablePath in planner.ts.
  const wsl = meta.workspace.replace(
    /^([A-Za-z]):[/\\](.*)$/,
    (_m, drive, rest) => `/mnt/${drive.toLowerCase()}/${rest.replace(/\\/g, '/')}`,
  );

  let paths: string[] = [];
  let method: CacheEntry['method'] = 'fs-walk';
  const gitPaths = await tryGitLsFiles(wsl);
  if (gitPaths) {
    paths = gitPaths;
    method = 'git-ls-files';
  } else {
    await walkFs(wsl, wsl, paths);
  }

  const truncated = paths.length >= WALK_MAX_FILES;
  cache.set(params.swarmRunID, {
    paths,
    truncated,
    method,
    capturedAtMs: Date.now(),
  });

  return Response.json({ paths, truncated, method, cached: false });
}
