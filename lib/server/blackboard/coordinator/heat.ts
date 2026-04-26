// Stigmergy-flavored heat scoring for the picker.
//
// scoreTodoByHeat computes a "this todo touches files the swarm already
// edited" score, decayed by a half-life so old hot files fade. The
// picker sorts OPEN todos by this score ASCENDING (exploratory bias —
// steer workers toward unexplored files) with createdAtMs ASC as the
// tiebreak. A todo with no file attribution scores 0 and falls back
// to oldest-first, which is the correct degenerate case.
//
// PATTERN_DESIGN/stigmergy.md I1 — heat half-life decay. Without this,
// editCount accumulates forever and an early-hot file dominates the
// score for hours after it's been quiet, anchoring the swarm. Decay
// weights each file's contribution by 0.5^(Δt / HEAT_HALF_LIFE_MS),
// where Δt is wallclock since the file was last touched. Recent edits
// count fully; old edits fade out. Half-life is configurable via
// OPENCODE_HEAT_HALF_LIFE_S (seconds); default 1800 (30 min) is gentler
// than the spec's 130s but matches our typical session pacing. Override
// to 130 for spec-literal validation runs.
//
// Extracted from coordinator.ts in #107 phase 3.

import type { FileHeat } from '../../../opencode/transform';

const HEAT_HALF_LIFE_DEFAULT_MS = 30 * 60 * 1000;

function heatHalfLifeMs(): number {
  const env = process.env.OPENCODE_HEAT_HALF_LIFE_S;
  if (!env) return HEAT_HALF_LIFE_DEFAULT_MS;
  const n = parseInt(env, 10);
  if (!Number.isFinite(n) || n <= 0) return HEAT_HALF_LIFE_DEFAULT_MS;
  return n * 1000;
}

function decayFactor(lastTouchedMs: number): number {
  if (lastTouchedMs <= 0) return 1; // unknown timestamp = no decay
  const dt = Math.max(0, Date.now() - lastTouchedMs);
  return Math.pow(0.5, dt / heatHalfLifeMs());
}

// Stigmergy v1 — pheromone-weighted pick. Score a todo by summing the
// edit counts of heat entries whose path or containing dir or basename
// appears in the todo's content. Three match tiers:
//
//   * Full-path match (content includes `src/foo/bar.ts`): +2x count
//     — strong signal, the todo explicitly names the file
//   * Directory match (content includes `src/foo/` when h.path is
//     `src/foo/bar.ts`): +1x count — todo targets the dir that owns
//     this file. Covers the "fix everything in src/components/" case.
//   * Basename match (content includes `bar.ts`, len ≥ 4): +1x count
//     — weakest, covers the "edit bar.ts" case where h.path has a
//     different leading dir
//
// Basenames under 4 chars are skipped — matching "ts" or "js" would
// be noise.
export function scoreTodoByHeat(
  content: string,
  heat: FileHeat[],
  pickedSessionID?: string,
): number {
  let score = 0;
  for (const h of heat) {
    const norm = h.path.replace(/\\/g, '/');
    const lastSlash = norm.lastIndexOf('/');
    const base = lastSlash >= 0 ? norm.slice(lastSlash + 1) : norm;
    const dirWithSlash = lastSlash >= 0 ? norm.slice(0, lastSlash + 1) : '';
    const decay = decayFactor(h.lastTouchedMs);
    const decayedCount = h.editCount * decay;
    let weight = 0;
    if (content.includes(h.path) || content.includes(norm)) {
      weight = 2;
    } else if (dirWithSlash && content.includes(dirWithSlash)) {
      weight = 1;
    } else if (base.length >= 4 && content.includes(base)) {
      weight = 1;
    }
    if (weight > 0) {
      score += decayedCount * weight;
      // PATTERN_DESIGN/stigmergy.md I4 — per-worker warmth bonus.
      // Picker sorts ascending (low-heat = preferred), so subtracting
      // here biases the picked session toward files it has already
      // touched (exploitation). Coefficient 0.5 keeps the global
      // exploratory bias dominant when the worker is one of many
      // touchers, but lets a sole-toucher tip toward continuing where
      // they have session context.
      if (pickedSessionID) {
        const sessionEdits = h.editsBySession?.[pickedSessionID] ?? 0;
        if (sessionEdits > 0) {
          score -= 0.5 * sessionEdits * decay * weight;
        }
      }
    }
  }
  return score;
}
