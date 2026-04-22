// Singleton SQLite connection for the blackboard preset's authoritative state.
//
// Location: `.opencode_swarm/blackboard.sqlite` by default; overridable via
// OPENCODE_SWARM_ROOT. Schema is applied idempotently on first open so a
// fresh clone or a wiped ledger works out of the box — no separate migrate
// step to forget. Pattern-matches lib/server/memory/db.ts deliberately so
// the two server-side DBs share operational ergonomics.
//
// Why a separate file from memory.sqlite: memory is regenerable derived
// index (drop + reindex is a supported workflow), the board is authoritative
// run state (loses claims if dropped mid-run). Different data gravity, so
// different file even if the dep is shared.
//
// Server-only. Import from API routes and scripts; never from a 'use client'
// file.

import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT =
  process.env.OPENCODE_SWARM_ROOT ??
  path.join(process.cwd(), '.opencode_swarm');

const DB_PATH = path.join(ROOT, 'blackboard.sqlite');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let conn: DB | null = null;

// Next.js dev mode can hot-reload this module, so we keep the singleton on
// globalThis to survive reloads and avoid leaking open file descriptors.
type GlobalWithBoard = typeof globalThis & { __opencode_blackboard_db?: DB };
const g = globalThis as GlobalWithBoard;

export function blackboardDb(): DB {
  if (conn) return conn;
  if (g.__opencode_blackboard_db) {
    conn = g.__opencode_blackboard_db;
    return conn;
  }

  mkdirSync(ROOT, { recursive: true });
  const db = new Database(DB_PATH);

  // Same pragma tuning as memory.sqlite — WAL + NORMAL sync is the standard
  // single-machine durable-enough + fast combo. The board is write-light
  // compared to memory ingest, so there's no reason to deviate.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.pragma('foreign_keys = ON');

  // No columns to ALTER in yet — fresh schema, single source of truth is
  // schema.sql. Kept as a stub so future additions can follow the same
  // migrate-before-exec order that memory/db.ts documents.
  migrate(db);
  const schema = readFileSync(resolveSchema(), 'utf8');
  db.exec(schema);

  conn = db;
  g.__opencode_blackboard_db = db;
  return db;
}

function migrate(_db: DB): void {
  // No migrations yet. Pattern: inspect PRAGMA table_info and ALTER TABLE
  // … ADD COLUMN when a column is absent, BEFORE db.exec(schema) runs so
  // schema.sql's partial indexes can validate against the new column. See
  // lib/server/memory/db.ts migrate() for a worked example.
}

function resolveSchema(): string {
  try {
    readFileSync(SCHEMA_PATH, 'utf8');
    return SCHEMA_PATH;
  } catch {
    return path.join(process.cwd(), 'lib', 'server', 'blackboard', 'schema.sql');
  }
}

export function closeBlackboardDb(): void {
  if (conn) {
    conn.close();
    conn = null;
    delete g.__opencode_blackboard_db;
  }
}
