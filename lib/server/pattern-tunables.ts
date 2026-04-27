//
// Pre-fix: ~13 magic-number constants scattered across the 5 pattern
// files (council, critic-loop, debate-judge, deliberate-execute,
// map-reduce). Each was `const FOO_MS = N * 60_000` with a justifying
// comment. Tunable via patch — but a stress test that wanted to sweep
// "all wait timeouts ÷ 2" had to grep + edit each file.
//
// Post-fix: this module is the central registry. Pattern files import
// from here instead of inlining. Stress tests can override at module-
// load via the standard ES-module mechanism. NOT env-var-driven —
// that's a separate scope decision (config sprawl was bounded in C5;
// tunables are code-default constants, not user config).

import 'server-only';

// ----- TIMINGS — wait windows, deadlines ------------------------------------

export const TIMINGS = {
  council: {
    // Per-round wait between member dispatches. Long enough that a
    // slow ollama-cloud model can complete a meaningful draft;
    // short enough that a stuck round doesn't hold a 60-min stress
    // test hostage past minute 50.
    roundWaitMs: 10 * 60 * 1000,
  },
  critic: {
    // Per-iteration worker→critic→revise wait window. Capped at 15
    // min because a critic-loop with 3 iterations × 15 min already
    // matches typical run budgets.
    iterationWaitMs: 15 * 60 * 1000,
  },
  debate: {
    // Per-round wait between generator drafts + judge verdict.
    // Longer than council's because the judge has to read every
    // generator's output before deciding.
    roundWaitMs: 20 * 60 * 1000,
  },
  deliberateExecute: {
    // Synthesis-phase wait — the orchestrator combining the
    // deliberation drafts into a directive.
    synthesisWaitMs: 15 * 60 * 1000,
    // Verifier sub-phase (post-synthesis sanity check).
    verifierWaitMs: 5 * 60 * 1000,
  },
  mapReduce: {
    // Per-mapper session wait. Longer than council/debate because
    // mappers do heavy file work, not just text generation.
    sessionWaitMs: 25 * 60 * 1000,
    // Synthesis dispatch deadline — the reduce step's hard cap.
    dispatchDeadlineMs: 5 * 60 * 1000,
    // Tick cadence for polling mapper completion. 3s is below the
    // typical opencode session-idle settle time so we don't
    // false-positive completion.
    tickIntervalMs: 3000,
    // Per-iteration wait when synthesis-critic is enabled (the
    // post-synthesis review loop).
    synthesisCriticWaitMs: 5 * 60 * 1000,
  },
} as const;

// ----- THRESHOLDS — convergence, scope balance, retry caps ------------------

export const THRESHOLDS = {
  council: {
    // Token-jaccard similarity threshold above which the council is
    // considered "converged". 0.85 picked empirically — more lenient
    // and false convergence triggers; stricter and convergence rarely
    // fires before the round cap.
    convergence: 0.85,
  },
  critic: {
    // Maximum confidence value the critic can stamp on a "nitpick"
    // verdict before it counts as substantive feedback. Used in
    // the verdict classifier; values >3 escalate the iteration.
    nitpickConfMax: 3,
  },
  deliberateExecute: {
    // Char-length threshold for "directive is small enough to not
    // need synthesis" — under this, skip synthesis and go straight
    // to execution.
    directiveSmallChars: 200,
    // Synthesis retry cap — if the synthesis output fails
    // verification, we'll retry this many times before giving up.
    maxSynthesisRetries: 1,
  },
  mapReduce: {
    // Imbalance ratio above which we warn that one mapper has way
    // more files than another — usually means slice partitioning
    // is broken.
    scopeImbalance: 5,
    // Hard cap on per-mapper draft size when feeding into
    // synthesis. Prevents one verbose mapper from eating the
    // entire synthesizer's context window (#97 fix lineage).
    maxDraftCharsForSynthesis: 80_000,
    // Synthesis-critic max revision rounds.
    maxSynthesisCriticRevisions: 2,
  },
} as const;
