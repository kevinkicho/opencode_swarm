import { describe, expect, it } from 'vitest';
import {
  isWallClockExpired,
  effectiveMinutesCap,
  formatWallClockState,
  DEFAULT_NONTICKER_WALLCLOCK_MINUTES,
} from '../swarm-bounds';

const NOW = 1_700_000_000_000; // arbitrary fixed reference time
const minutes = (n: number) => n * 60_000;

describe('effectiveMinutesCap', () => {
  it('uses bounds.minutesCap when set', () => {
    expect(effectiveMinutesCap({ bounds: { minutesCap: 15 } })).toBe(15);
  });

  it('falls through to default when bounds is undefined', () => {
    expect(effectiveMinutesCap({})).toBe(DEFAULT_NONTICKER_WALLCLOCK_MINUTES);
  });

  it('falls through when minutesCap is undefined inside bounds', () => {
    expect(effectiveMinutesCap({ bounds: {} })).toBe(
      DEFAULT_NONTICKER_WALLCLOCK_MINUTES,
    );
  });
});

describe('isWallClockExpired', () => {
  it('false when elapsed is well under cap', () => {
    expect(
      isWallClockExpired({ bounds: { minutesCap: 60 } }, NOW - minutes(10), NOW),
    ).toBe(false);
  });

  it('true when elapsed equals cap exactly', () => {
    expect(
      isWallClockExpired({ bounds: { minutesCap: 60 } }, NOW - minutes(60), NOW),
    ).toBe(true);
  });

  it('true when elapsed exceeds cap', () => {
    expect(
      isWallClockExpired({ bounds: { minutesCap: 5 } }, NOW - minutes(10), NOW),
    ).toBe(true);
  });

  it('uses default cap when bounds is empty', () => {
    expect(
      isWallClockExpired({}, NOW - minutes(DEFAULT_NONTICKER_WALLCLOCK_MINUTES + 1), NOW),
    ).toBe(true);
    expect(
      isWallClockExpired({}, NOW - minutes(DEFAULT_NONTICKER_WALLCLOCK_MINUTES - 1), NOW),
    ).toBe(false);
  });
});

describe('formatWallClockState', () => {
  it('renders elapsed/cap minute pair', () => {
    expect(
      formatWallClockState({ bounds: { minutesCap: 60 } }, NOW - minutes(15), NOW),
    ).toBe('15min/60min cap');
  });

  it('rounds elapsed to nearest minute', () => {
    expect(
      formatWallClockState(
        { bounds: { minutesCap: 60 } },
        NOW - minutes(5) - 25_000, // 5min 25s
        NOW,
      ),
    ).toBe('5min/60min cap');
  });
});
