// Singleton SQLite connection for the L1 part index + L2 rollups store.
//
// Location: `.opencode_swarm/memory.sqlite` by default; overridable via
// OPENCODE_SWARM_ROOT. Schema is applied idempotently on first open so a
// fresh clone or a wiped ledger works out of the box — no separate migrate
// step to forget.
//
// Server-only. Import from API routes, scripts, and rollup/ingest modules;
// never from a 'use client' file.

import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT =
  process.env.OPENCODE_SWARM_ROOT ??
  path.join(process.cwd(), '.opencode_swarm');

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

  // Order matters: migrate BEFORE exec(schema). The schema file declares a
  // partial index `ON parts(file_paths) WHERE file_paths IS NOT NULL`, and
  // on a stale DB `CREATE TABLE IF NOT EXISTS parts` skips (table exists,
  // old shape, no file_paths) — the partial index then throws "no such
  // column: file_paths", aborting the whole schema exec before later tables
  // (diffs, …) get created. Running migrate() first ALTERs the column in,
  // so the subsequent schema exec validates cleanly on both fresh + stale
  // installs.
  migrate(db);
  const schema = readFileSync(resolveSchema(), 'utf8');
  db.exec(schema);

  conn = db;
  g.__opencode_memory_db = db;
  return db;
}

// Lightweight column-level migrations. SQLite rejects `ADD COLUMN IF NOT
// EXISTS`, so we inspect table_info first and only ALTER when absent. Each
// block here should stay idempotent + cheap — this runs on every memoryDb()
// open, BEFORE schema.sql is exec'd. Existing rows are left with NULL on
// the new column; a reindex will backfill patch/file rows with their paths.
// Dropping the sqlite file is also a supported "migration" at the prototype
// stage. Index creation is left to schema.sql (single source of truth) —
// we only need ALTER TABLE here.
function migrate(db: DB): void {
  const cols = db
    .prepare("PRAGMA table_info('parts')")
    .all() as Array<{ name: string }>;
  if (cols.length === 0) return; // fresh install — schema.sql will create parts with file_paths
  const has = (name: string) => cols.some((c) => c.name === name);
  if (!has('file_paths')) {
    db.exec('ALTER TABLE parts ADD COLUMN file_paths TEXT');
  }
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
