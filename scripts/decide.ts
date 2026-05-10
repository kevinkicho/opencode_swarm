#!/usr/bin/env npx tsx
// @ts-nocheck
//
// Decision script — applies the composite plan's 6 rules to determine
// whether a proposed change is worth implementing.
//
// Run: npx tsx scripts/decide.ts --desc "..." --effort 8 --quadrant core
//
// Composite plan rules (LCCA-validated):
//   1. reducesInterventions AND effort <= 8h → DO (433% ROI)
//   2. isFeature AND postmortemRate >= 2.5 → SKIP
//   3. isReliability AND reducesInterventions → DO (all 5 agree)
//   4. quadrant === 'diversification' → SKIP (Ansoff trap)
//   5. effort > 40h → INVESTIGATE
//   6. Otherwise → INVESTIGATE

import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const PM_DIR = resolve(process.cwd(), 'docs', 'POSTMORTEMS');

function parseDate(filename: string): Date | null {
  const m = filename.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function currentPostmortemRate(): number {
  try {
    const files = readdirSync(PM_DIR).filter(
      (f) => f.endsWith('.md') && f !== 'README.md',
    );
    const dates: Date[] = [];
    for (const f of files) {
      const d = parseDate(f);
      if (d) dates.push(d);
    }
    dates.sort((a, b) => a.getTime() - b.getTime());
    if (dates.length < 2) return 0;
    const first = dates[0];
    const last = dates[dates.length - 1];
    const spanWeeks = (last.getTime() - first.getTime()) / (7 * 24 * 60 * 60 * 1000);
    return spanWeeks > 0 ? dates.length / spanWeeks : 0;
  } catch {
    return 0;
  }
}

function parseArgs(): {
  desc: string;
  effort: number;
  quadrant: string;
  reducesInterventions: boolean;
  isReliability: boolean;
  isFeature: boolean;
} {
  const args: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) {
        args[key] = process.argv[i + 1];
        i += 1;
      } else {
        args[key] = 'true';
      }
    }
  }
  return {
    desc: args.desc ?? '',
    effort: Number(args.effort) || 0,
    quadrant: args.quadrant ?? 'core',
    reducesInterventions: args['reduces-interventions'] === 'true',
    isReliability: args['is-reliability'] === 'true',
    isFeature: args['is-feature'] === 'true',
  };
}

function main(): void {
  const opts = parseArgs();
  const pmRate = currentPostmortemRate();

  const matched: string[] = [];

  // Rule 1: reducesInterventions AND effort <= 8h → DO
  if (opts.reducesInterventions && opts.effort > 0 && opts.effort <= 8) {
    matched.push('Rule 1: reduces interventions + effort ≤ 8h (433% ROI)');
  }

  // Rule 2: isFeature AND postmortemRate >= 2.5 → SKIP
  if (opts.isFeature && pmRate >= 2.5) {
    console.log('SKIP');
    console.log(`  Matched Rule 2: feature work at postmortem rate ${pmRate.toFixed(1)}/week ≥ 2.5`);
    return;
  }

  // Rule 3: isReliability AND reducesInterventions → DO
  if (opts.isReliability && opts.reducesInterventions) {
    matched.push('Rule 3: reliability work that reduces interventions (all 5 agree)');
  }

  // Rule 4: quadrant === 'diversification' → SKIP
  if (opts.quadrant === 'diversification') {
    console.log('SKIP');
    console.log('  Matched Rule 4: diversification quadrant (Ansoff trap)');
    return;
  }

  // Rule 5: effort > 40h → INVESTIGATE
  if (opts.effort > 40) {
    console.log('INVESTIGATE');
    console.log(`  Matched Rule 5: effort ${opts.effort}h > 40h`);
    return;
  }

  if (matched.length > 0) {
    console.log('DO');
    for (const m of matched) {
      console.log(`  ${m}`);
    }
  } else {
    console.log('INVESTIGATE');
    console.log('  No strong rule matched — manual review recommended');
  }
}

main();
