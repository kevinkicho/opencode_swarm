// Build conformance gate — runs `tsc --noEmit` in the workspace before
// marking a todo as done. Opt-in via `enableBuildGate` on the run request.
//
// The gate executes the typecheck as a child process (not through an
// opencode session) so it doesn't consume LLM tokens. If tsc exits
// non-zero, the item bounces to stale with a `[build-failed]` note
// showing the first few error lines. Fail-open on any execution error
// (tsc not installed, working directory missing, timeout) — only a
// genuine typecheck failure blocks the commit.
//
// DESIGN: positioned as Gate 5 in run-gate-checks.ts, after the
// verifier gate. Intentionally lightweight — no LLM needed, just
// `tsc --noEmit` as the conformance bar. DESIGN.md §9 calls this
// "pre-commit verify gate."

import 'server-only';

import { execFile } from 'node:child_process';
import path from 'node:path';

export interface BuildGateInput {
  workspace: string;
  timeoutMs?: number;
}

export interface BuildGateResult {
  verdict: 'pass' | 'fail' | 'unclear';
  reason: string;
  errorOutput?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ERROR_LINES = 10;

export function runBuildGate(input: BuildGateInput): Promise<BuildGateResult> {
  const { workspace, timeoutMs = DEFAULT_TIMEOUT_MS } = input;
  const cwd = path.resolve(workspace);

  return new Promise((resolve) => {
    const child = execFile(
      'npx',
      ['tsc', '--noEmit'],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      },
      (error, _stdout, stderr) => {
        if (error?.killed) {
          resolve({
            verdict: 'unclear',
            reason: `tsc timed out after ${timeoutMs}ms`,
          });
          return;
        }
        if (error) {
          const exitCode = error.code ?? 1;
          if (typeof exitCode === 'number' && exitCode > 0) {
            const lines = (stderr || error.message || '')
              .split('\n')
              .filter((l: string) => l.trim())
              .slice(0, MAX_ERROR_LINES)
              .join('\n');
            resolve({
              verdict: 'fail',
              reason: `tsc --noEmit exited ${exitCode}`,
              errorOutput: lines || undefined,
            });
          } else {
            resolve({
              verdict: 'unclear',
              reason: `tsc failed with code ${exitCode}: ${error.message}`,
            });
          }
          return;
        }
        resolve({ verdict: 'pass', reason: 'tsc --noEmit clean' });
      },
    );
    child.on('error', (err) => {
      resolve({
        verdict: 'unclear',
        reason: `tsc execution error: ${err.message}`,
      });
    });
  });
}