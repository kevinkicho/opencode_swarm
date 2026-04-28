# CALL_GRAPH.md

Generated 2026-04-26. Files scanned: 269. Function defs: 792.

## High-fan-in hubs (≥8 caller files) — break these and many cascade

| Function | Defined in | Callers |
|---|---|---|
| `getRun` | lib/server/swarm-registry/fs.ts | 28 |
| `compact` | lib/format.ts | 14 |
| `listBoardItems` | lib/server/blackboard/store.ts | 13 |
| `getSessionMessagesServer` | lib/server/opencode-server.ts | 9 |
| `abortSessionServer` | lib/server/opencode-server.ts | 8 |

## Cross-module duplicates (same name, multiple files)

| Name | Defined in N files |
|---|---|
| `GET` | 11 (app/api/swarm/providers/route.ts, app/api/swarm/run/[swarmRunID]/board/events/route.ts, app/api/swarm/run/[swarmRunID]/board/ticker/route.ts, app/api/swarm/run/[swarmRunID]/events/route.ts…) |
| `POST` | 8 (app/api/_debug/swarm-run/[swarmRunID]/retry-stale/route.ts, app/api/_debug/swarm-run/[swarmRunID]/sweep/route.ts, app/api/_debug/swarm-run/[swarmRunID]/tick/route.ts, app/api/swarm/memory/rollup/route.ts…) |
| `wrap` | 6 (components/contracts-rail.tsx, components/council-rail.tsx, components/debate-rail.tsx, components/iterations-rail.tsx…) |
| `fmtAge` | 5 (app/board-preview/page.tsx, app/debug/opencode/live-view.tsx, components/board-full-view.tsx, components/repo-runs-view.tsx…) |
| `fmtDuration` | 4 (lib/opencode/transform/_shared.ts, components/repo-runs-view.tsx, components/retro-view.tsx, components/turn-cards-view/turn-card-row.tsx) |
| `parseVerdict` | 4 (lib/server/blackboard/critic.ts, lib/server/blackboard/verifier.ts, components/debate-rail.tsx, components/iterations-rail.tsx) |
| `tokenize` | 3 (lib/opencode/transform/to-run-plan.ts, lib/server/blackboard/plan-revisions.ts, components/council-rail.tsx) |
| `Section` | 3 (components/diagnostics-modal.tsx, components/new-run/sub-components.tsx, components/spawn-agent-modal.tsx) |
| `subscribeBoardEvents` | 2 (lib/blackboard/board-events-multiplexer.ts, lib/server/blackboard/bus.ts) |
| `ownerIdForSession` | 2 (lib/blackboard/roles.ts, lib/server/blackboard/coordinator/message-helpers.ts) |
| `isChunkLoadError` | 2 (lib/lazy-with-retry.ts, components/chunk-error-reload.tsx) |
| `fmtTs` | 2 (lib/opencode/transform/_shared.ts, components/run-provenance-drawer.tsx) |
| `previewOf` | 2 (lib/opencode/transform/_shared.ts, components/run-provenance-drawer.tsx) |
| `isPlainObject` | 2 (lib/opencode/validate-part.ts, lib/server/swarm-registry-validate.ts) |
| `failOnce` | 2 (lib/opencode/validate-part.ts, lib/server/swarm-registry-validate.ts) |
| `liveAutoTicker` | 2 (lib/server/blackboard/auto-ticker/tick.ts, lib/server/blackboard/auto-ticker.ts) |
| `buildCriticPrompt` | 2 (lib/server/blackboard/critic.ts, lib/server/map-reduce.ts) |
| `resolveSchema` | 2 (lib/server/blackboard/db.ts, lib/server/memory/db.ts) |
| `hydrate` | 2 (lib/server/blackboard/plan-revisions.ts, lib/server/blackboard/store.ts) |
| `buildRevisionPrompt` | 2 (lib/server/critic-loop.ts, lib/server/debate-judge.ts) |
| `costForAssistant` | 2 (lib/server/memory/rollup-compute.ts, lib/server/swarm-registry/derive.ts) |
| `BoardCard` | 2 (app/board-preview/page.tsx, components/board-full-view.tsx) |
| `fmtTime` | 2 (app/debug/opencode/session/[id]/page.tsx, components/projects-matrix.tsx) |
| `repoNameOf` | 2 (app/projects/[slug]/page.tsx, components/projects-matrix.tsx) |
| `formatTokens` | 2 (components/cost-dashboard.tsx, components/cross-preset-metrics.tsx) |
| `directiveTeaser` | 2 (components/cost-dashboard.tsx, components/swarm-runs-picker.tsx) |
| `diffSummary` | 2 (components/council-rail.tsx, components/debate-rail.tsx) |
| `classify` | 2 (components/critic-verdict-strip.tsx, components/judge-verdict-strip.tsx) |
| `classifySlots` | 2 (components/debate-rail.tsx, components/iterations-rail.tsx) |
| `EmptyHint` | 2 (components/diagnostics-modal.tsx, components/glossary/sections.tsx) |

## Possibly unused (no caller outside the defining file): 542

Note: regex-based — misses dynamic dispatch, default exports, JSX consumption (`<Foo>`),
and things called via re-exports. Treat as candidates for review, not certainties.

Top 30 by file (deepest dead-code suspects):

- `components/icons.tsx` (32): base, IconRead, IconEdit, IconWrite, IconBash, IconGrep…
- `components/ui/stats-stream.tsx` (15): StatsStream, MetricCell, ViewTab, Sparkline, SampleTable, metricValue…
- `components/new-run/sub-components.tsx` (13): CountStepper, BoundRow, PatternCard, StrategyCard, ModeButton, ModeHint…
- `components/projects-matrix.tsx` (13): dayKeyOf, dayStartMs, fmtDayShort, fmtDayLong, groupByWorkspace, bucketByDay…
- `components/cost-dashboard.tsx` (12): weeklyBuckets, shortWorkspace, commonPrefix, formatMoney, formatTokens, directiveTeaser…
- `components/retro-view.tsx` (12): isFailureStop, fmtMinutes, fmtAbsTime, RetroView, Header, RunOverview…
- `app/api/swarm/providers/route.ts` (11): getCache, familyFromZen, inferFamily, inferVendor, normalizeModelsField, toProviderModel…
- `components/diagnostics-modal.tsx` (10): DiagnosticsModal, ToolCatalogSection, DriftRow, McpServersSection, mcpStatusTone, ConfigSection…
- `lib/opencode/client.ts` (9): basicAuthHeader, circuitState, recordFailure, recordSuccess, isCircuitTripped, isHardNetworkFailure…
- `lib/server/swarm-registry/fs.ts` (9): runDir, legacyMetaPath, eventsPath, eventsGzPath, sessionIndex, mintSwarmRunID…
- `components/council-rail.tsx` (9): diffSummary, pairJaccard, aggregateJaccard, convergenceTone, convergenceLabel, stanceBucket…
- `components/map-rail.tsx` (9): extractScope, countFilesTouched, sessionTokens, sessionStatus, sessionOutputLines, MapRail…
- `lib/server/debate-judge.ts` (8): buildGeneratorIntroPrompt, buildJudgeIntroPrompt, buildJudgmentPrompt, parseConfidence, parseGeneratorBullets, classifyJudgeReply…
- `lib/server/map-reduce.ts` (8): walkScopeBytes, approxScopeBytes, truncateDraftForSynthesis, buildSynthesisPrompt, pickCriticSession, parseCriticVerdict…
- `components/cross-preset-metrics.tsx` (8): formatDur, formatUsd, formatPct, median, sum, computePatternStats…
- `components/event-info.tsx` (8): EventInfo, ToolPanel, DiffPreview, ChainGroup, ChainRow, AgentChip…
- `components/glossary/sections.tsx` (8): SectionCard, PartsSection, ToolsSection, EventsSection, StatusSection, StatusRow…
- `lib/server/opencode-log-tail.ts` (7): defaultLogDir, fallbackWindowsLogDir, findActiveLog, isNoise, tickTail, discoveryTick…
- `components/chat-pane.tsx` (7): ChatPane, ChatHeader, MessageRow, UserMessage, ThinkingBlock, AssistantMessage…
- `components/contracts-rail.tsx` (7): parseNote, deriveCounts, ContractsRail, ContractsListBody, wrap, Chip…
- `components/inspector/sub-components.tsx` (7): EmptyState, MessageInspector, PermissionPanel, AgentPill, ToolIconInline, Stat…
- `lib/server/blackboard/planner/parsers.ts` (6): stripVerifyTag, stripRoleTag, stripFilesTag, stripRoleNoteTag, stripFromTag, stripCriterionTag
- `lib/server/memory/rollup-compute.ts` (6): sha256, extractTodowriteTodos, firstInProgressHash, costForAssistant, normalizePlanStatus, reducePart
- `components/run-provenance-drawer.tsx` (6): RunProvenanceDrawer, PhaseChip, CountPill, EventRow, tailID, classifyType
- `lib/opencode/transform/to-run-plan.ts` (5): rawTodosFromState, mapTodoStatus, taskCallsFrom, tokenize, containment
- `lib/opencode/validate-part.ts` (5): isPlainObject, signatureFor, failOnce, tryStringify, _resetValidatePartWarnCache
- `lib/server/blackboard/auditor.ts` (5): auditLocks, withAuditLock, truncateContent, buildAuditPrompt, parseVerdictBatch
- `lib/server/blackboard/auto-ticker/tick.ts` (5): liveAutoTicker, isIdleOutcome, makeSlot, ensureSlots, tickSession
- `lib/server/critic-loop.ts` (5): buildWorkerIntroPrompt, buildCriticIntroPrompt, buildReviewPrompt, buildRevisionPrompt, classifyCriticReply
- `lib/server/demo-log-retention.ts` (5): retentionDays, autoDeleteEnabled, compressFileIfBig, compressRunDir, isOlderThan

## Per-file complexity (top 20 by function count)

| File | Lines | Functions defined |
|---|---|---|
| components/icons.tsx | 263 | 33 |
| lib/opencode/live/_fetchers.ts | 417 | 21 |
| lib/opencode/transform/_shared.ts | 205 | 16 |
| components/projects-matrix.tsx | 479 | 15 |
| components/ui/stats-stream.tsx | 389 | 15 |
| lib/server/swarm-registry/fs.ts | 410 | 14 |
| components/new-run/sub-components.tsx | 484 | 14 |
| components/retro-view.tsx | 423 | 14 |
| lib/server/map-reduce.ts | 771 | 13 |
| lib/opencode/client.ts | 224 | 12 |
| components/cost-dashboard.tsx | 424 | 12 |
| app/api/swarm/providers/route.ts | 368 | 11 |
| components/council-rail.tsx | 442 | 11 |
| lib/playback-context.tsx | 168 | 10 |
| lib/server/debate-judge.ts | 648 | 10 |
| lib/server/opencode-log-tail.ts | 264 | 10 |
| lib/server/swarm-registry/derive.ts | 511 | 10 |
| components/diagnostics-modal.tsx | 498 | 10 |
| components/map-rail.tsx | 473 | 10 |
| lib/server/blackboard/store.ts | 403 | 9 |

## Files importing from many places (high static fan-out)

| File | Import statements |
|---|---|
| app/page.tsx | 47 |
| lib/server/blackboard/coordinator/dispatch/pick-claim.ts | 16 |
| components/new-run-modal.tsx | 16 |
| components/swarm-timeline.tsx | 16 |
| app/api/swarm/run/route.ts | 15 |
| lib/server/blackboard/auto-ticker/tick.ts | 14 |
| lib/server/blackboard/planner/sweep.ts | 14 |
| lib/server/map-reduce.ts | 12 |
| components/left-tabs.tsx | 12 |
| components/swarm-topbar.tsx | 12 |
| lib/server/swarm-registry/fs.ts | 11 |
| components/inspector/sub-components.tsx | 11 |
| lib/server/blackboard/coordinator/dispatch/run-gate-checks.ts | 10 |
| components/board-rail.tsx | 10 |
| components/swarm-runs-picker.tsx | 10 |

## Direct import cycles (A imports B AND B imports A): 2

- `lib/blackboard/board-events-multiplexer.ts` ⟷ `lib/blackboard/live.ts`
- `lib/blackboard/board-events-multiplexer.ts` ⟷ `lib/blackboard/strategy.ts`

