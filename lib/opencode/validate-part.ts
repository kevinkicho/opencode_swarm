// HARDENING_PLAN.md#R2 — SDK schema-drift firewall.
//
// opencode's SDK types declare which message-part shapes we expect; the
// transform.ts narrowing trusts those shapes via TS-only filters. When
// opencode emits a part with a new type field or a missing required
// field — exactly the Q34/Q42 failure mode — the trust passes the cast
// silently and the UI consumes garbage.
//
// `validatePart` runs at the SSE-deserialize boundary: every parsed
// JSON payload that *claims* to be an OpencodePart goes through here
// before being handed to `transform`. Unknown shapes drop with a
// console.warn so dev logs surface drift; never silently propagated.
//
// One-time-per-signature warn cache so a million SSE events don't
// produce a million warns for the same drift.

import type { OpencodePart, OpencodePartType } from './types';

const KNOWN_PART_TYPES: ReadonlySet<OpencodePartType> = new Set([
  'text',
  'reasoning',
  'tool',
  'step-start',
  'step-finish',
  'patch',
]);

// Required fields on the discriminator-true variants. Listed at the
// minimum we need before downstream transform runs — extra fields are
// fine (forward-compat).
const REQUIRED_BY_TYPE: Record<OpencodePartType, readonly string[]> = {
  text: ['text'],
  reasoning: ['text'],
  tool: [], // tool/state are optional per the SDK type; transform handles undefined
  'step-start': [],
  'step-finish': ['reason', 'cost', 'tokens'],
  patch: ['hash', 'files'],
};

// All parts share the OpencodePartBase fields (id, sessionID, messageID,
// type). Validators check those AND the per-type requirements above.
const REQUIRED_ON_BASE = ['id', 'sessionID', 'messageID', 'type'] as const;

export type ValidatePartResult =
  | { ok: true; part: OpencodePart }
  | { ok: false; reason: string; raw: unknown };

// Tracks which drift signatures we've already warned about so a flood
// of identical-shape unknown events produces one log line, not thousands.
const warnedSignatures = new Set<string>();

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function signatureFor(reason: string, raw: unknown): string {
  if (!isPlainObject(raw)) return `${reason}::primitive`;
  const t = typeof raw.type === 'string' ? raw.type : '<no-type>';
  return `${reason}::${t}`;
}

export function validatePart(raw: unknown): ValidatePartResult {
  if (!isPlainObject(raw)) {
    return failOnce('part is not an object', raw);
  }

  for (const field of REQUIRED_ON_BASE) {
    if (!(field in raw)) {
      return failOnce(`missing required base field '${field}'`, raw);
    }
  }

  const t = raw.type;
  if (typeof t !== 'string') {
    return failOnce('type field is not a string', raw);
  }
  if (!KNOWN_PART_TYPES.has(t as OpencodePartType)) {
    return failOnce(`unknown part type '${t}'`, raw);
  }

  const required = REQUIRED_BY_TYPE[t as OpencodePartType];
  for (const field of required) {
    if (!(field in raw)) {
      return failOnce(`type='${t}' missing required field '${field}'`, raw);
    }
  }

  // All checks passed. Cast through OpencodePart — we've validated the
  // discriminator + base fields + per-type requirements. Any extra fields
  // on `raw` are ignored downstream; that's forward-compat.
  return { ok: true, part: raw as unknown as OpencodePart };
}

function failOnce(reason: string, raw: unknown): ValidatePartResult {
  const sig = signatureFor(reason, raw);
  if (!warnedSignatures.has(sig)) {
    warnedSignatures.add(sig);
    console.warn(
      `[opencode/validate-part] schema drift — ${reason}.`,
      'Sample raw:',
      tryStringify(raw),
    );
  }
  return { ok: false, reason, raw };
}

function tryStringify(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 240);
  } catch {
    return String(v).slice(0, 240);
  }
}

// Test-only helper to reset the warn cache between assertions. Not used
// in production; export here so the test file can import without going
// through globals.
export function _resetValidatePartWarnCache(): void {
  warnedSignatures.clear();
}
