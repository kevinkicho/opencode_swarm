// HARDENING_PLAN.md#C5 — central registry for HTTP API request/response
// shapes that cross the server-client boundary.
//
// Pre-fix: 7 inline interfaces lived inside individual app/api/**/route.ts
// files (TickBody, SweepBody, PostBody (×2 — one in board, one in
// board/ticker — disambiguated below), ActionBody, StopResponse,
// GateBlock). Clients had to re-key request bodies by hand because the
// types weren't importable.
//
// All shapes are still validated runtime-side at the route by the
// route's own parseFooBody helper (R6) — the interfaces here just give
// the client and server a shared TypeScript contract.

// ----- POST /api/swarm/run/:id/board ---------------------------------------

// Body shape for POST /board (insert a board item from outside the
// coordinator). Each field is optional at the type level; the route's
// parsePost validates required-vs-optional per item kind.
export interface BoardPostBody {
  id?: string;
  kind?: string;
  content?: string;
  status?: string;
  ownerAgentId?: string;
  note?: string;
  fileHashes?: Array<{ path?: unknown; sha?: unknown }>;
}

// ----- POST /api/swarm/run/:id/board/[itemId] ------------------------------

// Body shape for board-item action POSTs. action is the discriminator;
// per-action helpers in the route validate the rest.
export interface BoardActionBody {
  action?: string;
  ownerAgentId?: string;
  fileHashes?: Array<{ path?: unknown; sha?: unknown }>;
  note?: string;
}

// ----- POST /api/swarm/run/:id/board/sweep ---------------------------------

export interface BoardSweepBody {
  overwrite?: unknown;
  timeoutMs?: unknown;
}

// ----- POST /api/swarm/run/:id/board/tick ----------------------------------

export interface BoardTickBody {
  timeoutMs?: unknown;
}

// ----- POST /api/swarm/run/:id/board/ticker --------------------------------

export interface BoardTickerPostBody {
  action?: unknown; // 'start' | 'stop'
  periodicSweepMinutes?: unknown;
}

// ----- POST /api/swarm/run/:id/stop ----------------------------------------

export interface StopResponse {
  ok: true;
  swarmRunID: string;
  sessionsAborted: number;
  tickerStopped: boolean;
}

// ----- /api/opencode/[...path] cost-cap gate -------------------------------

// Returned in the 402 body when the cost-cap gate fires. CostCapError
// in lib/opencode/errors.ts has matching field names so clients can
// `instanceof` after fetch errors and read the same shape.
export interface CostCapGateBlock {
  swarmRunID: string;
  costTotal: number;
  costCap: number;
}

// ----- canonical error response shape (HARDENING_PLAN.md#R5) --------------

// Every Response.json error site uses this shape. Discriminator-style
// fields (swarmRunID, sessionIDs, attempts, etc.) accompany when
// relevant — see lib/__tests__/hardening/api-error-shape.test.ts for
// the allowlist.
export interface ApiErr {
  error: string;
  detail?: string;
  hint?: string;
}
