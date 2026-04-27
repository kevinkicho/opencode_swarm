// Singleton SQLite connection for the L2 rollups store.
//
// Location: `.opencode_swarm/memory.sqlite` by default; overridable via
// OPENCODE_SWARM_ROOT. Schema is applied idempotently on first open so a
// fresh clone or a wiped ledger works out of the box — no separate migrate
// step to forget.
//
// Server-only. Import from API routes and rollup modules; never from a
// 'use client' file.

import 'server-only';

import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { OPENCODE_SWARM_ROOT as ROOT } from '../../config';

const DB_PATH = path.join(ROOT, 'memory.sqlite');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let conn: DB | null = null;

// Opens the connection lazily. Next.js dev mode can hot-reload this module,
// so we keep the singleton on globalThis to survive reloads and avoid
// leaking open file descriptors.
type GlobalWithMemory = typeof globalThis & { __opencode_memory_db?: DB };
const g = globalThis as GlobalWithMemory;

export function memoryDb(): DB {
  if (conn) return conn;
  if (g.__opencode_memory_db) {
    conn = g.__opencode_memory_db;
    return conn;
  }

  mkdirSync(ROOT, { recursive: true });
  const db = new Database(DB_PATH);

  // Pragmas tuned for append-heavy + ad-hoc read workloads on a single
  // machine. WAL + NORMAL sync is the standard Node/SQLite combo — durable
  // enough that a crash loses at most the last transaction, fast enough
  // that background ingest doesn't starve query reads.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.pragma('foreign_keys = ON');

  const schema = readFileSync(resolveSchema(), 'utf8');
  db.exec(schema);

  conn = db;
  g.__opencode_memory_db = db;
  return db;
}

// Schema path resolves differently under next's bundled server vs. a
// standalone `node` script. Try the co-located path first; fall back to a
// repo-root lookup so the bundled output still finds the file.
function resolveSchema(): string {
  try {
    readFileSync(SCHEMA_PATH, 'utf8');
    return SCHEMA_PATH;
  } catch {
    return path.join(process.cwd(), 'lib', 'server', 'memory', 'schema.sql');
  }
}

export function closeMemoryDb(): void {
  if (conn) {
    conn.close();
    conn = null;
    delete g.__opencode_memory_db;
  }
}
