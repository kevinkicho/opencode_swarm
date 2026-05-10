// Pure heuristic pattern recommender. No AI call — keyword/heuristic
// classification runs synchronously, zero latency, zero cost.
// Returns the best-matching SwarmPattern or null when the directive is
// too short or ambiguous.

import type { SwarmPattern } from './swarm-types';

// Weighted keyword buckets per pattern. Each entry is [keyword, weight].
// Higher weight = stronger signal for that pattern. Short words are
// fine because we match on word boundaries (not substrings).
type Bucket = [string, number][];

const BUCKETS: Record<SwarmPattern, Bucket> = {
  none: [],

  blackboard: [
    ['implement', 2],
    ['fix', 2],
    ['bug', 2],
    ['refactor', 1],
    ['change', 1],
    ['update', 1],
    ['modify', 1],
    ['add', 1],
    ['remove', 1],
    ['migrate', 2],
    ['port', 2],
    ['rewrite', 2],
    ['todos', 1],
    ['checklist', 1],
    ['task', 1],
    ['tasks', 2],
    ['items', 1],
    ['parallel', 1],
    ['independent', 2],
    ['batch', 2],
    ['all of these', 2],
    ['each of the following', 2],
    ['sweep', 1],
    ['audit', 1],
    ['multiple bugs', 3],
    ['several bugs', 3],
    ['list of', 1],
  ],

  'map-reduce': [
    ['survey', 3],
    ['analyze', 2],
    ['summarize', 3],
    ['review', 2],
    ['assess', 2],
    ['catalog', 3],
    ['inventory', 3],
    ['map', 2],
    ['find all', 2],
    ['find every', 2],
    ['coverage', 2],
    ['comprehensive', 2],
    ['overview', 2],
    ['report', 2],
    ['synthesis', 3],
    ['syntheses', 3],
    ['across the codebase', 2],
    ['across the repo', 2],
    ['codebase-wide', 2],
    ['every file', 2],
    ['all files', 2],
  ],

  council: [
    ['compare', 3],
    ['compare approaches', 4],
    ['pros and cons', 3],
    ['trade-offs', 3],
    ['tradeoff', 3],
    ['trade-off', 3],
    ['alternatives', 3],
    ['which approach', 4],
    ['decide between', 4],
    ['choose between', 4],
    ['design decision', 3],
    ['architecture decision', 3],
    ['opinion', 2],
    ['perspectives', 2],
    ['divergent', 2],
    ['brainstorm', 2],
    ['explore options', 3],
    ['evaluate options', 3],
  ],

  'orchestrator-worker': [
    ['implement end-to-end', 4],
    ['end-to-end', 3],
    ['decompose', 2],
    ['delegate', 2],
    ['orchestrate', 3],
    ['coordinate', 2],
    ['multi-step', 3],
    ['long mission', 3],
    ['full feature', 3],
    ['from scratch', 2],
    ['build', 2],
    ['ship', 1],
    ['strategy', 2],
    ['coordinate', 2],
  ],

  'debate-judge': [
    ['which is better', 4],
    ['debate', 3],
    ['defend', 2],
    ['argue', 2],
    ['judge', 3],
    ['evaluate proposal', 3],
    ['pick the best', 4],
    ['choose the best', 4],
    ['rank', 2],
    ['score', 2],
    ['winner', 3],
    ['verdict', 3],
    ['adjudicate', 4],
    ['proposal', 2],
    ['proposals', 3],
  ],

  'critic-loop': [
    ['refine', 3],
    ['improve', 2],
    ['polish', 3],
    ['quality', 2],
    ['rewrite until', 4],
    ['iterate on', 3],
    ['critique', 3],
    ['review and improve', 4],
    ['draft', 2],
    ['revise', 3],
    ['tighten', 2],
    ['copy', 1],
    ['ux', 1],
    ['usability', 1],
    ['writing', 2],
    ['prose', 3],
    ['style', 2],
    ['clean up', 2],
    ['make it better', 3],
  ],

  pipeline: [
    ['then implement', 4],
    ['then build', 3],
    ['then execute', 4],
    ['then code', 3],
    ['explore then', 3],
    ['first explore', 3],
    ['first analyze', 3],
    ['then act', 4],
    ['then fix', 3],
    ['then ship', 3],
    ['multi-phase', 3],
    ['multi phase', 3],
    ['phased', 2],
    ['phase 1', 2],
    ['phase 2', 2],
    ['step 1', 2],
    ['step 2', 2],
    ['after exploring', 3],
    ['after analyzing', 3],
  ],
};

const MIN_DIRECTIVE_LENGTH = 10;
const MIN_SCORE = 4;

// Split directive into lowercase word-boundary tokens for matching.
// This prevents substring matches (e.g., "fix" inside "prefix").
function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\b/).filter((t) => t.trim().length > 0);
}

export function recommendPattern(directive: string): SwarmPattern | null {
  if (!directive || directive.trim().length < MIN_DIRECTIVE_LENGTH) return null;

  const lower = directive.toLowerCase();
  // Multi-word phrase matching (higher signal) runs first.
  // Then single-word matching. Both use the bucket weights.

  let bestPattern: SwarmPattern | null = null;
  let bestScore = 0;

  for (const [pattern, bucket] of Object.entries(BUCKETS) as [SwarmPattern, Bucket][]) {
    if (pattern === 'none') continue;
    let score = 0;
    for (const [keyword, weight] of bucket) {
      // Multi-word keywords: check if the phrase appears in the directive
      if (keyword.includes(' ')) {
        if (lower.includes(keyword)) {
          score += weight;
        }
      } else {
        // Single-word keywords: match on word boundaries only
        const re = new RegExp(`\\b${keyword}\\b`, 'i');
        if (re.test(lower)) {
          score += weight;
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestPattern = pattern;
    }
  }

  return bestScore >= MIN_SCORE ? bestPattern : null;
}