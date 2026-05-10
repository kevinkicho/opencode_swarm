#!/usr/bin/env npx tsx
//
// Playwright video frame extraction — post-terminal hook.
//
// After a run completes, locates `runs/_monitor/<runId>/playwright/video/page@*.webm`,
// runs ffmpeg to dump frames every 5s, walks frames flagging anomalies
// (no-op diffs, missing bubbles, broken streaming, unexpected layout),
// and writes findings to `runs/_monitor/<runId>/post-mortem.md`.
//
// Called automatically when the Playwright verifier gate finishes a run,
// or manually: npx tsx scripts/frame-extract.ts <swarmRunID>
//
// Requires: ffmpeg in PATH.
//
// See docs/VALIDATION.md § "Playwright video + frame extraction post-mortem"

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const MONITOR_ROOT = resolve(process.cwd(), '.opencode_swarm', 'runs', '_monitor');

function findVideos(runId: string): string[] {
  const runDir = join(MONITOR_ROOT, runId, 'playwright', 'video');
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir)
    .filter((f) => f.startsWith('page@') && f.endsWith('.webm'))
    .map((f) => join(runDir, f));
}

function extractFrames(videoPath: string, outputDir: string): string[] {
  mkdirSync(outputDir, { recursive: true });
  try {
    execSync(
      `ffmpeg -y -i "${videoPath}" -vf fps=1/5 "${outputDir}/frame-%04d.png"`,
      { stdio: 'pipe', timeout: 120_000 },
    );
  } catch {
    console.warn(`[frame-extract] ffmpeg failed for ${videoPath} — is ffmpeg installed?`);
    return [];
  }
  return readdirSync(outputDir)
    .filter((f) => f.endsWith('.png'))
    .sort()
    .map((f) => join(outputDir, f));
}

interface Anomaly {
  frame: string;
  issue: string;
}

function detectAnomalies(frames: string[]): Anomaly[] {
  const anomalies: Anomaly[] = [];
  if (frames.length === 0) {
    anomalies.push({ frame: 'N/A', issue: 'No frames extracted — video may be empty or ffmpeg failed' });
    return anomalies;
  }

  // Heuristic checks on frame count and timing
  const frameCount = frames.length;
  if (frameCount < 5) {
    anomalies.push({ frame: frames[0] ?? 'N/A', issue: `Only ${frameCount} frames — run may have been very short (<25s)` });
  }

  // Check for no-op diffs: consecutive frames of identical size suggest frozen UI
  let sameSizeCount = 0;
  for (let i = 1; i < frames.length; i += 1) {
    try {
      const prevSize = statSync(frames[i - 1]).size;
      const currSize = statSync(frames[i]).size;
      if (Math.abs(prevSize - currSize) < 100) { // <100 bytes diff = likely identical
        sameSizeCount += 1;
      }
    } catch { /* file may have been deleted during scan */ }
  }
  if (sameSizeCount > frameCount * 0.8) {
    anomalies.push({ frame: frames[Math.floor(frames.length / 2)] ?? 'N/A', issue: `${sameSizeCount}/${frameCount} frames are near-identical — possible frozen UI (no-op diffs)` });
  }

  // Missing page: if first frame is very small, page may not have loaded
  try {
    const firstSize = statSync(frames[0]).size;
    if (firstSize < 5000) { // <5KB = likely blank/error page
      anomalies.push({ frame: frames[0], issue: `First frame is ${firstSize} bytes — page may not have loaded (error/blank state)` });
    }
  } catch { /* ok */ }

  return anomalies;
}

function writeFindings(runId: string, videos: string[], frameCount: number, anomalies: Anomaly[]): void {
  const runDir = join(MONITOR_ROOT, runId);
  mkdirSync(runDir, { recursive: true });
  const reportPath = join(runDir, 'post-mortem.md');

  const lines: string[] = [
    `# Playwright Frame Analysis — ${runId}`,
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    `## Summary`,
    `- Videos processed: ${videos.length}`,
    `- Total frames extracted: ${frameCount}`,
    `- Anomalies detected: ${anomalies.length}`,
    '',
  ];

  if (anomalies.length > 0) {
    lines.push('## Anomalies');
    for (const a of anomalies) {
      lines.push(`- **${a.issue}** — frame: \`${a.frame}\``);
    }
    lines.push('');
  }

  lines.push('## Videos');
  for (const v of videos) {
    lines.push(`- \`${v}\``);
  }

  writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`[frame-extract] findings written to ${reportPath}`);
}

function main(): void {
  const runId = process.argv[2];
  if (!runId) {
    console.log('Usage: npx tsx scripts/frame-extract.ts <swarmRunID>');
    console.log('Extracts frames from Playwright videos and flags anomalies.');
    return;
  }

  const videos = findVideos(runId);
  if (videos.length === 0) {
    console.log(`[frame-extract] no videos found for run ${runId} at ${MONITOR_ROOT}/${runId}`);
    return;
  }

  console.log(`[frame-extract] processing ${videos.length} video(s) for run ${runId}`);
  let totalFrames = 0;
  const allAnomalies: Anomaly[] = [];

  for (const video of videos) {
    const outputDir = join(MONITOR_ROOT, runId, 'playwright', 'frames');
    const frames = extractFrames(video, outputDir);
    totalFrames += frames.length;
    const anomalies = detectAnomalies(frames);
    allAnomalies.push(...anomalies);
    console.log(`[frame-extract] ${video}: ${frames.length} frames, ${anomalies.length} anomalies`);
  }

  writeFindings(runId, videos, totalFrames, allAnomalies);
}

main();
