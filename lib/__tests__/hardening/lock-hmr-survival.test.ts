//
// `criticLocks`, `verifierLocks`, `auditLocks` are plain `const Map`
// declarations. On Next.js HMR, the module is replaced and the lock map
// resets to empty. After D2 ships, each should be globalThis-pinned via
// Symbol.for(...) the same way `bus.ts` does it.
//
// This is a lint-style test that verifies the source contains the
// globalThis pattern for each lock site, NOT a runtime test of HMR
// (which would require running Next.js dev server).
//
// Status: target — fails today on 3 known sites.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');

interface LockFile {
  path: string;
  symbolHint: string; // expected Symbol.for() suffix
  lockVarName: string;
}

const LOCK_FILES: LockFile[] = [
  {
    path: 'lib/server/blackboard/critic.ts',
    symbolHint: 'criticLocks',
    lockVarName: 'criticLocks',
  },
  {
    path: 'lib/server/blackboard/verifier.ts',
    symbolHint: 'verifierLocks',
    lockVarName: 'verifierLocks',
  },
  {
    path: 'lib/server/blackboard/auditor.ts',
    symbolHint: 'auditLocks',
    lockVarName: 'auditLocks',
  },
];

function isGlobalThisPinned(src: string, lockVar: string): boolean {
  // Two acceptable shapes, both globalThis-keyed:
  //
  //   (A) const KEY = Symbol.for(...); function <lockVar>() { ... globalThis ... }
  //   (B) const KEY = Symbol.for(...); const <lockVar> = g[KEY] ?? ...;
  //
  // Both end with the lockVar reachable via globalThis. The unsafe
  // pattern we're catching is `const <lockVar> = new Map()` at module
  // scope with no globalThis indirection — that's the HMR-volatile shape.
  if (!src.includes('Symbol.for(')) return false;

  // Reject the direct `const <lockVar> = new Map(` shape (no globalThis
  // between the const and the new Map). Look for a const declaration of
  // the lockVar that immediately assigns `new Map(...)` on the same line.
  const directNewMap = new RegExp(
    `^const\\s+${lockVar}\\s*(?::[^=]+)?=\\s*new\\s+Map\\b`,
    'm',
  );
  if (directNewMap.test(src)) return false;

  // Accept either the function-returning-Map shape OR the const-from-globalThis
  // shape. We detect by presence of a function declaration for lockVar OR a
  // const declaration that references globalThis/g[KEY].
  const fnPattern = new RegExp(`function\\s+${lockVar}\\s*\\(`);
  if (fnPattern.test(src)) return true;

  const constFromGlobal = new RegExp(
    `const\\s+${lockVar}\\s*=\\s*[^;]*(?:globalThis|\\bg\\[)`,
    'm',
  );
  return constFromGlobal.test(src);
}

describe('hardening · D2 · lock map HMR survival', () => {
  for (const lock of LOCK_FILES) {
    it(`${lock.path} pins ${lock.lockVarName} on globalThis`, () => {
      const fullPath = join(REPO_ROOT, lock.path);
      const src = readFileSync(fullPath, 'utf8');
      const ok = isGlobalThisPinned(src, lock.lockVarName);
      if (!ok) {
        throw new Error(
          [
            `D2 violation: ${lock.path} declares \`const ${lock.lockVarName} = new Map(...)\``,
            `which is replaced on HMR, resetting the lock state.`,
            `Pin via Symbol.for('opencode_swarm.${lock.symbolHint}') the way lib/server/blackboard/bus.ts does.`,
 `See `,
          ].join('\n'),
        );
      }
      expect(ok).toBe(true);
    });
  }
});
