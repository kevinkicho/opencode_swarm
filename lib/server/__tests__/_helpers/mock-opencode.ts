// Type contract + inline-recipe for mocking `lib/server/opencode-server.ts`.
//
// Centralized in _helpers/ as part of #111 so tests that exercise
// orchestration code (waitForSessionIdle, dispatch, kickoffs) share the
// same shape. The type lives here; the factory call has to be inlined
// at the test file's top level via `vi.hoisted` because vi.hoisted
// runs BEFORE any module imports resolve — there's no way to import a
// helper-defined factory and reference it inside the hoisted callback.
//
// Recipe (copy into your test):
//
//   import { vi } from 'vitest';
//   import type { OpencodeServerMocks } from '../_helpers/mock-opencode';
//
//   const opencodeMocks: OpencodeServerMocks = vi.hoisted(() => ({
//     getSessionMessagesServer: vi.fn().mockResolvedValue([]),
//     abortSessionServer: vi.fn().mockResolvedValue(undefined),
//     postSessionMessageServer: vi.fn().mockResolvedValue(undefined),
//   }));
//   vi.mock('../../opencode-server', () => opencodeMocks);
//
//   // … later in the test
//   opencodeMocks.getSessionMessagesServer.mockResolvedValue([msg]);

import type { Mock } from 'vitest';

export interface OpencodeServerMocks {
  getSessionMessagesServer: Mock;
  abortSessionServer: Mock;
  postSessionMessageServer: Mock;
}
