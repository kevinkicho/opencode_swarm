// opencode JSON fixtures.
//
// Pre-fix transform.ts had 17 unit tests covering only parsers
// (parseUnifiedDiff, parseSessionDiffs, filterDiffsForTurn). The 8
// main transformers (toAgents, toMessages, toRunMeta, toLiveTurns,
// toFileHeat, toTurnCards, toRunPlan, toProviderSummary) were
// untested.
//
// This test drives every transformer through every captured opencode
// fixture in __fixtures__/ and snapshots the result. PRs that change
// transform output have to update the snapshot — visible review
// signal. Q34/Q42-class regressions (model emits an unexpected shape
// → silent corruption downstream) get caught by the snapshot diff.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  toAgents,
  toFileHeat,
  toLiveTurns,
  toMessages,
  toProviderSummary,
  toRunMeta,
  toRunPlan,
  toTurnCards,
} from '../transform';
import type { OpencodeMessage } from '../types';

const FIXTURES_DIR = join(__dirname, '..', '__fixtures__');

interface CaptureWrapper {
  captureMeta: {
    source: string;
    pattern: string;
    role: string;
    capturedAt: number;
  };
  message: OpencodeMessage;
}

const fixtures = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({
    name: f.replace(/\.json$/, ''),
    path: join(FIXTURES_DIR, f),
  }));

describe('transform · fixture-driven (D7 schema-drift firewall)', () => {
  it('fixture corpus exists', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  // Every fixture must be valid JSON parsing into the wrapper shape.
  for (const fx of fixtures) {
    it(`${fx.name} parses cleanly`, () => {
      const raw = JSON.parse(readFileSync(fx.path, 'utf8')) as CaptureWrapper;
      expect(raw.message).toBeDefined();
      expect(raw.message.info).toBeDefined();
      expect(raw.captureMeta.pattern).toBeTruthy();
    });
  }

  // For each fixture, drive each transformer and snapshot the output.
  // Transformers that need additional context (toRunMeta needs a
  // session, toProviderSummary needs agents) get minimal stand-ins.
  for (const fx of fixtures) {
    describe(`${fx.name}`, () => {
      const wrapper = JSON.parse(
        readFileSync(fx.path, 'utf8'),
      ) as CaptureWrapper;
      const messages: OpencodeMessage[] = [wrapper.message];

      it(`toAgents`, () => {
        expect(toAgents(messages)).toMatchSnapshot();
      });

      it(`toMessages`, () => {
        expect(toMessages(messages)).toMatchSnapshot();
      });

      it(`toRunMeta`, () => {
        // Synthesize a minimal session so toRunMeta has its required
        // input. Fixture's message carries enough info to drive every
        // assertion the transformer makes.
        const fakeSession = {
          id: wrapper.message.info.sessionID ?? 'ses_fixture',
          slug: 'fx',
          projectID: 'global',
          directory: '/USER/workspace',
          title: 'fixture',
          version: '1.0',
          summary: { diffs: [] },
          time: { created: 0, updated: 0 },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        expect(toRunMeta(fakeSession, messages)).toMatchSnapshot();
      });

      it(`toLiveTurns`, () => {
        expect(toLiveTurns(messages)).toMatchSnapshot();
      });

      it(`toFileHeat`, () => {
        expect(toFileHeat(messages)).toMatchSnapshot();
      });

      it(`toTurnCards`, () => {
        expect(toTurnCards(messages)).toMatchSnapshot();
      });

      it(`toRunPlan`, () => {
        expect(toRunPlan(messages)).toMatchSnapshot();
      });

      it(`toProviderSummary`, () => {
        // toProviderSummary takes agents AS WELL as messages. Use the
        // agents derived from this fixture so the test is reproducible
        // from the fixture alone.
        const agents = toAgents(messages).agents;
        expect(toProviderSummary(agents, messages)).toMatchSnapshot();
      });
    });
  }
});
