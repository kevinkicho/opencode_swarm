// HARDENING_PLAN.md#C17 — break the heat-rail.tsx ↔ sub-components.tsx
// import cycle by hoisting the shared type to a leaf module.
//
// Pre-fix: heat-rail.tsx exported DiffStatsByPath; sub-components.tsx
// imported it back through the parent. Now both depend on this file.

export type DiffStatsByPath = Map<string, { added: number; deleted: number }>;
