# Pattern: role-differentiated

**Status:** shipped, unvalidated
**Session topology:** session 0 = architect (planner + worker); sessions 1..N = remaining roles in preset rotation (builder, tester, reviewer, security, ux, data, docs)
**Observability maturity:** low — role chips exist on board rows, but no surface shows work distribution or role-affinity

## 1 · Mechanics

Blackboard variant where every session carries a role identity that
shapes its self-concept. Unlike orchestrator-worker, session 0 ALSO
works on todos — roles are soft differentiation, not dispatch routing.

- **Kickoff:** `runRoleDifferentiatedKickoff` (lib/server/).
  Resolves team roles from the default preset
  (`resolveTeamRoles`), posts role-framed intros to each session
  with `agent={role-name}`. Session 0 (architect) also gets the
  planner sweep.
- **Role intro prompt:** `buildRoleIntroPrompt` frames the session's
  self-concept ("you are the tester; you self-select items best
  matched to your role but are not restricted to them"). No hard
  routing.
- **Preferred-role tag:** planner can optionally tag todos with
  `[role:tester]` content prefix. Parsed by the planner and stored
  on the BoardItem (`preferredRole` field, `lib/blackboard/types.ts:82`).
- **Matcher bias:** coordinator's picker scores items higher when the
  session's role matches `preferredRole`. It's a bias, not a
  constraint — a tester can claim an architect-tagged item if no
  architect is idle.
- **Rest:** identical to blackboard. Same ticker, same CAS, same
  critic / auditor / verifier opt-ins.

## 2 · Signals already emitted

- Role name per session (via opencode's `agent` field)
- `preferredRole` on each BoardItem (set by planner prefix parse)
- `ownerAgentId` at claim time (maps back to a role via session lookup)
- Role rotation preset (which sessions got which roles)

What's NOT surfaced today:
- Count of role-matched vs role-mismatched claims
- Per-role completion / stale rates
- Per-role average iteration time
- Which role is bottlenecking (e.g. tester claimed 0 items all run)

## 3 · Observability surface

### Existing
- `board-rail` shows role chips on board rows via `roleNamesFromMeta`
  lookup in `lib/blackboard/live.ts`. No filtering, no aggregation.

### Proposed — `roles` tab

**Scope:** `pattern === 'role-differentiated'`. Left-panel tab group.

**Layout:** matrix, one row per role. h-5 rows, monospace.

| col | content | width |
|---|---|---|
| stripe | left-edge accent stripe in role's accent color | 4px |
| role | role name (uppercase, tracking-widest2, 10px) | 88px |
| session | session slot (s0, s1, …) | 32px |
| claimed | count of items ever claimed by this role | 40px |
| done | count completed | 40px |
| stale | count staled | 40px |
| match | `match% / N` — fraction of claims where preferredRole == role | 64px |
| avg-time | avg wall-clock per done item (tabular-nums `Xm`) | 40px |
| status | current activity: `idle`, `claiming`, `working`, `error` | 64px |

**Header chips:** `total claims <N>` · `match-rate <N%>` ·
`slowest-role <name> <Xm>`.

**Sort:** default by `done` desc. Header click to re-sort.

**Row hover:** tooltip shows the role intro excerpt so user recalls
that role's self-concept framing.

**Row click:** opens inspector drawer scoped to that role — shows
every item the role has touched, and the role intro text in full.

**Empty state:** `awaiting role assignments` when no sessions have
been dispatched yet.

**Aesthetic note:** each role has a reserved accent
(architect=iris, builder=molten, tester=amber, reviewer=mint,
security=rust, ux=fog, data=iris-muted, docs=fog). Use the stripe
to make the tab scannable as a color chart at a glance.

## 4 · Mechanics gaps

### I1 · Strict-mode role enforcement (opt-in)

Today match is advisory. Add a per-run flag
`strictRoleRouting: boolean`. When true, coordinator rejects
non-matching claims with note `[role-mismatch: <claimant-role> on
<preferred-role>]`, bounces item back to open. Lets power users
impose tactical constraints (e.g., "only the security role should
touch authentication code").

### I2 · Role-imbalance detector

If one role claims zero items while others exhaust themselves, the
team is imbalanced and the preset is wrong for this workload. After
15 min of run-time, if any role has `claimed === 0` while at least
one other role has `claimed >= 5`, log WARN and surface
"role X has been idle — consider a manual re-prompt" in the
run-health banner.

### I3 · Role intro drift

Role intros are static preset strings today. Planner has no mechanism
to refresh a role's self-concept when the workload shifts (e.g., a
frontend-heavy mission would benefit from the tester role
specializing in Playwright, not unit tests). Add per-sweep
role-intro-append capability: planner can emit a
`roleNote: { role, appendText }` tag that the next tick applies as
a clarification message to that role's session.

### I4 · Per-role rate limits / cost budgets

With mixed models (e.g., architect on glm-5.1 + testers on gemma4),
a role-level cost ceiling would prevent a single role from consuming
the entire budget. Add optional `roleBudgets: Record<role, tokens>`
at run creation.

## 5 · Ledger

| ID | Kind | Status | Commit | Verified against | Notes |
|---|---|---|---|---|---|
| roles-tab | tab | SHIPPED | (next commit) | — | LeftTabs gates on pattern=role-differentiated; per-role row w/ claimed/done/stale + preferredRole match-rate + avg-time + accent stripe |
| I1 | improvement | SHIPPED | (next commit) | — | meta.strictRoleRouting flag (default false): coordinator picker filters out items with non-matching preferredRole when the picked session has a role; on empty filtered queue, returns skipped with reason 'strict-role: no matches for session role X' (waits for matching item or another session) |
| I2 | improvement | SHIPPED | (next commit) | — | `checkRoleImbalance` fires inside auto-ticker fanout once per ROLE_IMBALANCE_REPEAT_MS=30 min, after a 15-min run-age grace. Aggregates non-open todos by `preferredRole`; logs WARN naming idle role(s) (claimed=0) when at least one busy role (claimed≥5) exists. Pattern-gated to role-differentiated only. |
| I3 | improvement | SHIPPED | (next commit) | — | planner can emit a `[rolenote:<role>] <text>` todowrite entry; `stripRoleNoteTag` extracts (normalized like stripRoleTag), `runPlannerSweep` collects them out of the board-insert path and posts each to the matching role's session via `postSessionMessageServer`. Planner prompt extended on role-differentiated runs to instruct sparing use. Smoke test covers tag match, normalization, no-prefix passthrough, empty-role non-match. |
| I4 | improvement | SHIPPED | (next commit) | — | `meta.roleBudgets: Record<role, tokens>` (default undefined → no caps). At picker time the coordinator sums per-role assistant-message tokens from `messagesByCandidate` (already-loaded, no extra fetch); if spent ≥ cap, returns `{status: 'skipped', reason: 'role-budget: <role> hit X/Y tokens'}` so dispatch lands elsewhere. Soft cutoff — already-claimed work finishes; only future claims to that role's session(s) are denied. |

## 6 · Cross-references

- `SWARM_PATTERNS.md` §6 — role-differentiated stance
- `lib/server/role-differentiated.ts` — kickoff + intro builder
- `lib/blackboard/types.ts:82-89` — `preferredRole` field
- `blackboard.md` — shared mechanics
- `memory/feedback_no_role_hierarchy.md` — the 2026-04-23 revision
  that made this pattern legitimate
