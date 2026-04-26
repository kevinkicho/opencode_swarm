// HARDENING_PLAN.md#D4 #3 + #D7 — transform tested against real
// opencode JSON fixtures.
//
// Today `transform.test.ts` covers parsers (parseUnifiedDiff,
// parseSessionDiffs, filterDiffsForTurn) — 17 cases. The 8 main
// transformers (toAgents, toMessages, toRunMeta, toLiveTurns,
// toFileHeat, toTurnCards, toRunPlan, toProviderSummary) are
// untested.
//
// The fix: capture real opencode message JSONs into
// `lib/opencode/__fixtures__/` (one per pattern: planner, worker,
// critic, council). Run each transformer against every fixture and
// snapshot the result.
//
// Status: scaffold. Un-skip once fixtures land.

import { describe } from 'vitest';

describe.skip('transform · fixture-driven shape coverage (D4 #3 + D7 — to be implemented)', () => {
  // Recipe:
  //
  //   import { readFileSync, readdirSync } from 'node:fs';
  //   import { join } from 'node:path';
  //   import { toAgents, toMessages, toRunMeta, ... } from '../transform';
  //
  //   const FIXTURES_DIR = join(__dirname, '..', '__fixtures__');
  //   const fixtures = readdirSync(FIXTURES_DIR)
  //     .filter((f) => f.endsWith('.json'))
  //     .map((f) => ({ name: f, data: JSON.parse(readFileSync(join(FIXTURES_DIR, f), 'utf8')) }));

  // === Each transformer × each fixture ===
  //
  // for (const fx of fixtures) {
  //   it(`toAgents on ${fx.name}`, () => expect(toAgents(fx.data)).toMatchSnapshot());
  //   it(`toMessages on ${fx.name}`, () => expect(toMessages(fx.data)).toMatchSnapshot());
  //   it(`toRunMeta on ${fx.name}`, () => expect(toRunMeta(fx.data)).toMatchSnapshot());
  //   it(`toLiveTurns on ${fx.name}`, () => expect(toLiveTurns(fx.data)).toMatchSnapshot());
  //   it(`toFileHeat on ${fx.name}`, () => expect(toFileHeat(fx.data)).toMatchSnapshot());
  //   it(`toTurnCards on ${fx.name}`, () => expect(toTurnCards(fx.data)).toMatchSnapshot());
  //   it(`toRunPlan on ${fx.name}`, () => expect(toRunPlan(fx.data)).toMatchSnapshot());
  //   it(`toProviderSummary on ${fx.name}`, () => expect(toProviderSummary(fx.data)).toMatchSnapshot());
  // }

  // === Drift detection ===
  //
  // it('every fixture parses without throwing');
  // it('every fixture has at least one message of each expected type');

  // === Q34 / Q42 firewall ===
  //
  // The fixture set MUST include:
  //   - planner-tier-1.json: a successful planner sweep reply
  //   - worker-with-tools.json: a worker turn with patch + tool parts
  //   - worker-text-only-skip.json: a worker that legitimately replied "skip:"
  //   - critic-approved.json: a critic verdict reply
  //   - council-round.json: a council deliberation round
  //
  // Snapshots from these fixtures are the firewall: a regression that
  // changes shape interpretation will fail the snapshot match.
});
