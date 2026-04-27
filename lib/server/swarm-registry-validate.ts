//
// Pre-fix: swarm-registry.ts:251 cast `JSON.parse(raw) as SwarmRunMeta`
// directly. A truncated or hand-edited meta.json passes the cast and
// propagates `undefined`-shaped data into every consumer. events.jsonl:857
// had the same shape — a corrupt line silently produced a "valid"
// SwarmRunEvent with missing fields.
//
// These validators run at the read boundary and return null on failure
// so the registry can swap-in a "missing" answer instead of poisoning
// downstream code with shape-cast garbage.

import 'server-only';

import type {
  SwarmRunEvent,
  SwarmRunMeta,
} from '../swarm-run-types';
import type { SwarmPattern } from '../swarm-types';

// One-time-per-shape warn cache. Same pattern as validate-part —
// flooding the dev log with a million parse warns when the same field
// is missing on every line of events.jsonl is unhelpful.
const warnedSignatures = new Set<string>();

const KNOWN_PATTERNS: ReadonlySet<SwarmPattern> = new Set<SwarmPattern>([
  'none',
  'blackboard',
  'orchestrator-worker',
  'role-differentiated',
  'council',
  'critic-loop',
  'debate-judge',
  'map-reduce',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function failOnce(reason: string, sig: string, sample: unknown): null {
  if (!warnedSignatures.has(sig)) {
    warnedSignatures.add(sig);
    let sampleStr: string;
    try {
      sampleStr = JSON.stringify(sample).slice(0, 240);
    } catch {
      sampleStr = String(sample).slice(0, 240);
    }
    console.warn(
      `[swarm-registry/validate] ${reason}. Sample:`,
      sampleStr,
    );
  }
  return null;
}

// Validate a SwarmRunMeta read from meta.json. Returns null on shape
// failure; logs once per unique signature.
export function validateSwarmRunMeta(raw: unknown): SwarmRunMeta | null {
  if (!isPlainObject(raw)) {
    return failOnce('meta is not an object', 'meta::not-object', raw);
  }
  if (typeof raw.swarmRunID !== 'string' || raw.swarmRunID.length === 0) {
    return failOnce(
      'meta missing or empty swarmRunID',
      'meta::missing-swarmRunID',
      raw,
    );
  }
  if (typeof raw.pattern !== 'string' || !KNOWN_PATTERNS.has(raw.pattern as SwarmPattern)) {
    return failOnce(
      `meta has unknown pattern '${String(raw.pattern)}'`,
      `meta::bad-pattern::${typeof raw.pattern}`,
      raw,
    );
  }
  if (typeof raw.workspace !== 'string') {
    return failOnce(
      'meta missing workspace field',
      'meta::missing-workspace',
      raw,
    );
  }
  if (!isStringArray(raw.sessionIDs)) {
    return failOnce(
      'meta.sessionIDs is not a string[]',
      'meta::bad-sessionIDs',
      raw,
    );
  }
  if (typeof raw.createdAt !== 'number') {
    return failOnce(
      'meta.createdAt is not a number',
      'meta::bad-createdAt',
      raw,
    );
  }
  // Cast through unknown — we've validated the discriminator-bearing
  // fields; the rest of SwarmRunMeta is optional. Forward-compat for
  // new optional fields opencode/our-side adds.
  return raw as unknown as SwarmRunMeta;
}

// Validate one event row from events.jsonl. Returns null on shape
// failure (caller should skip and continue iteration).
export function validateSwarmRunEvent(raw: unknown): SwarmRunEvent | null {
  if (!isPlainObject(raw)) {
    return failOnce('event is not an object', 'event::not-object', raw);
  }
  if (typeof raw.swarmRunID !== 'string') {
    return failOnce(
      'event missing swarmRunID field',
      'event::missing-swarmRunID',
      raw,
    );
  }
  if (typeof raw.sessionID !== 'string') {
    return failOnce(
      'event missing sessionID field',
      'event::missing-sessionID',
      raw,
    );
  }
  if (typeof raw.ts !== 'number') {
    return failOnce(
      'event.ts is not a number',
      'event::bad-ts',
      raw,
    );
  }
  if (typeof raw.type !== 'string') {
    return failOnce(
      'event.type is not a string',
      'event::bad-type',
      raw,
    );
  }
  // properties is `unknown` on the type so it's allowed to be anything
  // — opencode's event.properties shapes vary. We only check that the
  // key exists.
  if (!('properties' in raw)) {
    return failOnce(
      'event missing properties field',
      'event::missing-properties',
      raw,
    );
  }
  return raw as unknown as SwarmRunEvent;
}

// Memory-payload discriminator helper. AgentRollup vs RunRetro share a
// `kind` discriminator but the cast in lib/server/memory/{reader,query}.ts
// trusts it without checking. Returns the typed value or null.
export function validateMemoryKindDiscriminator(
  raw: unknown,
): { kind: string } | null {
  if (!isPlainObject(raw)) {
    return failOnce(
      'memory payload is not an object',
      'memory::not-object',
      raw,
    );
  }
  if (typeof raw.kind !== 'string') {
    return failOnce(
      'memory payload missing kind discriminator',
      'memory::missing-kind',
      raw,
    );
  }
  return raw as unknown as { kind: string };
}

// Test-only helper to reset the warn cache between assertions.
export function _resetSwarmRegistryValidateWarnCache(): void {
  warnedSignatures.clear();
}
