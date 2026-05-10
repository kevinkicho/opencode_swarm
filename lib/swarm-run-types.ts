// Wire contracts for the swarm-run backend (Tier 2 of the roadmap).
//
// A "swarm run" is one logical run that wraps N opencode sessions under a
// single coordinator. At v1 N=1 and the pattern is always 'none' — the
// shape generalizes to N when blackboard / map-reduce / council backends
// ship.
//
// Ownership: these types are shared between the browser (POST body, event
// consumer) and the Next.js route handler. Keep server-only types in
// `lib/server/` so this file stays import-safe from 'use client' modules.
//
// Split 2026-05-09 into domain files. This barrel re-exports for
// backward compatibility — no existing import paths need to change.

export type {
  SwarmRunRequest,
  SwarmRunBounds,
  PipelineConfig,
  PipelinePreset,
  PipelinePhase,
} from './run-config';

export type {
  SwarmRunMeta,
  SwarmRunStatus,
  SwarmRunListRow,
} from './run-status';

export type {
  SwarmRunResponse,
  SwarmRunEvent,
} from './run-events';
