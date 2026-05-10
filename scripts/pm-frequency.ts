#!/usr/bin/env npx tsx
//
// Postmortem frequency tracker — reads the postmortem directory and
// computes postmortems per week over the project lifetime.
//
// Run: npx tsx scripts/pm-frequency.ts
//
// LCCA finding: current rate (2.5/week) costs $195K/yr in maintenance.
// Target rate: <0.5/week after systematic fixes.

import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const PM_DIR = resolve(process.cwd(), 'docs', 'POSTMORTEMS');

// Parse dates from filenames like "2026-04-24-orchestrator-worker-silent.md"
function parseDate(filename: string): Date | null {
  const m = filename.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function main(): void {
  const files = readdirSync(PM_DIR).filter(f => f.endsWith('.md') && f !== 'README.md');
  const dates: Date[] = [];

  for (const f of files) {
    const d = parseDate(f);
    if (d) dates.push(d);
  }

  dates.sort((a, b) => a.getTime() - b.getTime());

  if (dates.length === 0) {
    console.log('No dated postmortems found.');
    return;
  }

  const first = dates[0];
  const last = dates[dates.length - 1];
  const spanDays = (last.getTime() - first.getTime()) / (24 * 60 * 60 * 1000);
  const spanWeeks = spanDays / 7;

  console.log('# Postmortem Frequency Report\n');
  console.log(`  Total postmortems: ${dates.length}`);
  console.log(`  First: ${first.toISOString().slice(0, 10)}`);
  console.log(`  Last: ${last.toISOString().slice(0, 10)}`);
  console.log(`  Span: ${spanDays.toFixed(0)} days (${spanWeeks.toFixed(1)} weeks)`);
  console.log(`  Rate: ${(dates.length / spanWeeks).toFixed(1)} postmortems/week\n`);

  // Weekly breakdown
  const weekBuckets = new Map<string, number>();
  for (const d of dates) {
    // ISO week: Monday = first day
    const day = d.getDay();
    const monday = new Date(d);
    monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    const key = monday.toISOString().slice(0, 10);
    weekBuckets.set(key, (weekBuckets.get(key) ?? 0) + 1);
  }

  console.log('| Week of | Count | Rate |');
  console.log('|----------|-------|------|');
  const sortedWeeks = [...weekBuckets.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [week, count] of sortedWeeks) {
    const status = count >= 3 ? '🔴' : count >= 2 ? '🟡' : '🟢';
    console.log(`| ${week} | ${count} | ${status} ${count >= 3 ? 'UNSUSTAINABLE' : count >= 2 ? 'HIGH' : 'OK'} |`);
  }

  // Recent trend (last 4 weeks)
  const fourWeeksAgo = new Date(last);
  fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
  const recent = dates.filter(d => d >= fourWeeksAgo);
  const recentRate = recent.length / 4;

  console.log(`\n## Recent Trend (last 4 weeks)`);
  console.log(`  Postmortems: ${recent.length}`);
  console.log(`  Rate: ${recentRate.toFixed(1)}/week`);

  if (recentRate >= 2.5) {
    console.log('  Status: CRITICAL — maintenance cost unsustainable ($195K/yr)');
    console.log('  Action: Prioritize reliability fixes over features');
  } else if (recentRate >= 1.0) {
    console.log('  Status: WARNING — maintenance cost elevated ($78K/yr)');
    console.log('  Action: Continue systematic fixes, track weekly');
  } else if (recentRate >= 0.5) {
    console.log('  Status: IMPROVING — approaching steady-state ($39K/yr)');
  } else {
    console.log('  Status: HEALTHY — steady-state achieved ($15.6K/yr)');
  }
}

main();
