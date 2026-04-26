# CALL_GRAPH.md

Generated 2026-04-26. Files scanned: 207. Function defs: 743.

## High-fan-in hubs (≥8 caller files) — break these and many cascade

| Function | Defined in | Callers |
|---|---|---|
| `getRun` | lib/server/swarm-registry.ts | 30 |
| `listBoardItems` | lib/server/blackboard/store.ts | 14 |
| `compact` | lib/format.ts | 12 |
| `getSessionMessagesServer` | lib/server/opencode-server.ts | 9 |

## Cross-module duplicates (same name, multiple files)

| Name | Defined in N files |
|---|---|
| `POST` | 12 (app/api/swarm/memory/reindex/route.ts, app/api/swarm/memory/rollup/route.ts, app/api/swarm/recall/route.ts, app/api/swarm/run/[swarmRunID]/board/[itemId]/route.ts…) |
| `GET` | 11 (app/api/swarm/run/[swarmRunID]/board/events/route.ts, app/api/swarm/run/[swarmRunID]/board/route.ts, app/api/swarm/run/[swarmRunID]/board/ticker/route.ts, app/api/swarm/run/[swarmRunID]/events/route.ts…) |
| `wrap` | 8 (components/contracts-rail.tsx, components/council-rail.tsx, components/debate-rail.tsx, components/iterations-rail.tsx…) |
| `extractLatestAssistantText` | 6 (lib/server/council.ts, lib/server/critic-loop.ts, lib/server/debate-judge.ts, lib/server/deliberate-execute.ts…) |
| `fmtAge` | 5 (app/board-preview/page.tsx, app/debug/opencode/live-view.tsx, components/board-full-view.tsx, components/repo-runs-view.tsx…) |
| `turnText` | 5 (components/council-rail.tsx, components/debate-rail.tsx, components/iterations-rail.tsx, components/map-rail.tsx…) |
| `countLines` | 5 (components/council-rail.tsx, components/debate-rail.tsx, components/iterations-rail.tsx, components/map-rail.tsx…) |
| `fmtDuration` | 4 (lib/opencode/transform.ts, components/repo-runs-view.tsx, components/retro-view.tsx, components/turn-cards-view.tsx) |
| `tokenize` | 4 (lib/opencode/transform.ts, lib/server/blackboard/plan-revisions.ts, components/council-rail.tsx, components/phases-rail.tsx) |
| `parseVerdict` | 4 (lib/server/blackboard/critic.ts, lib/server/blackboard/verifier.ts, components/debate-rail.tsx, components/iterations-rail.tsx) |
| `compactNum` | 4 (components/council-rail.tsx, components/debate-rail.tsx, components/iterations-rail.tsx, components/map-rail.tsx) |
| `ownerIdForSession` | 2 (lib/blackboard/roles.ts, lib/server/blackboard/coordinator/message-helpers.ts) |
| `isChunkLoadError` | 2 (lib/lazy-with-retry.ts, components/chunk-error-reload.tsx) |
| `fmtTs` | 2 (lib/opencode/transform.ts, components/run-provenance-drawer.tsx) |
| `previewOf` | 2 (lib/opencode/transform.ts, components/run-provenance-drawer.tsx) |
| `liveAutoTicker` | 2 (lib/server/blackboard/auto-ticker/tick.ts, lib/server/blackboard/auto-ticker.ts) |
| `sha7` | 2 (lib/server/blackboard/coordinator/path-utils.ts, app/api/swarm/run/[swarmRunID]/board/[itemId]/route.ts) |
| `buildCriticPrompt` | 2 (lib/server/blackboard/critic.ts, lib/server/map-reduce.ts) |
| `migrate` | 2 (lib/server/blackboard/db.ts, lib/server/memory/db.ts) |
| `resolveSchema` | 2 (lib/server/blackboard/db.ts, lib/server/memory/db.ts) |
| `hydrate` | 2 (lib/server/blackboard/plan-revisions.ts, lib/server/blackboard/store.ts) |
| `mintItemId` | 2 (lib/server/blackboard/planner.ts, app/api/swarm/run/[swarmRunID]/board/route.ts) |
| `buildRevisionPrompt` | 2 (lib/server/critic-loop.ts, lib/server/debate-judge.ts) |
| `buildSynthesisPrompt` | 2 (lib/server/deliberate-execute.ts, lib/server/map-reduce.ts) |
| `buildRow` | 2 (lib/server/memory/ingest.ts, components/timeline-flow/build-row.ts) |
| `estimateTokens` | 2 (lib/server/memory/query.ts, lib/server/opencode-models.ts) |
| `costForAssistant` | 2 (lib/server/memory/rollup.ts, lib/server/swarm-registry.ts) |
| `BoardCard` | 2 (app/board-preview/page.tsx, components/board-full-view.tsx) |
| `fmtTime` | 2 (app/debug/opencode/session/[id]/page.tsx, components/projects-matrix.tsx) |
| `repoNameOf` | 2 (app/projects/[slug]/page.tsx, components/projects-matrix.tsx) |

## Possibly unused (no caller outside the defining file): 573

Note: regex-based — misses dynamic dispatch, default exports, JSX consumption (`<Foo>`),
and things called via re-exports. Treat as candidates for review, not certainties.

Top 30 by file (deepest dead-code suspects):

- `components/icons.tsx` (32): base, IconRead, IconEdit, IconWrite, IconBash, IconGrep…
- `lib/opencode/transform.ts` (25): providerOf, derivedCost, familyOf, normalizeTool, normalizePart, toolStateFrom…
- `lib/server/blackboard/planner.ts` (17): isViableCriterion, tierName, buildPlannerPrompt, toNodeReadablePath, readWorkspaceReadme, buildPlannerBoardContext…
- `components/retro-view.tsx` (17): isFailureStop, fmtMinutes, fmtAbsTime, RetroView, Header, RunOverview…
- `lib/opencode/live.ts` (16): getJsonBrowser, getProjectsBrowser, getSessionsByDirectoryBrowser, getAllSessionsBrowser, getSessionMessagesBrowser, sessionMessagesQueryKey…
- `components/ui/stats-stream.tsx` (15): StatsStream, MetricCell, ViewTab, Sparkline, SampleTable, metricValue…
- `lib/server/swarm-registry.ts` (14): runDir, metaPath, eventsPath, eventsGzPath, sessionIndex, mintSwarmRunID…
- `components/new-run/sub-components.tsx` (14): Section, CountStepper, BoundRow, PatternCard, StrategyCard, ModeButton…
- `components/projects-matrix.tsx` (13): dayKeyOf, dayStartMs, fmtDayShort, fmtDayLong, groupByWorkspace, bucketByDay…
- `components/cost-dashboard.tsx` (12): weeklyBuckets, shortWorkspace, commonPrefix, formatMoney, formatTokens, directiveTeaser…
- `components/council-rail.tsx` (12): turnText, countLines, diffSummary, pairJaccard, aggregateJaccard, convergenceTone…
- `lib/server/map-reduce.ts` (11): deriveSlices, walkScopeBytes, approxScopeBytes, detectScopeImbalance, buildScopedDirective, runMapReduceSynthesis…
- `lib/server/memory/rollup.ts` (11): captureSessionDiffs, sha256, lookupSessionOrigin, extractTodowriteTodos, firstInProgressHash, costForAssistant…
- `components/board-rail.tsx` (11): retryCountFromNote, fileBasename, heatDecay, heatScoreForItem, heatBarTone, BoardRail…
- `components/inspector/sub-components.tsx` (11): EmptyState, MessageInspector, PermissionPanel, AgentInspector, ModelSwapRow, ModelPicker…
- `lib/server/debate-judge.ts` (9): buildGeneratorIntroPrompt, buildJudgeIntroPrompt, buildJudgmentPrompt, parseConfidence, parseGeneratorBullets, classifyJudgeReply…
- `components/glossary/sections.tsx` (9): SectionCard, PartsSection, ToolsSection, EventsSection, StatusSection, StatusRow…
- `components/map-rail.tsx` (9): extractScope, countFilesTouched, sessionTokens, sessionStatus, sessionOutputLines, MapRail…
- `lib/server/memory/query.ts` (8): globPrefix, globToRegex, decodeFilePaths, filePathsMatch, querySummaries, headlineFor…
- `components/cross-preset-metrics.tsx` (8): formatDur, formatUsd, formatPct, median, sum, computePatternStats…
- `components/event-info.tsx` (8): EventInfo, ToolPanel, DiffPreview, ChainGroup, ChainRow, AgentChip…
- `lib/server/deliberate-execute.ts` (7): classifyDirectiveComplexity, buildSynthesisVerifierPrompt, classifySynthesisReply, buildSynthesisRetryPrompt, seedTodosFromExtract, buildSynthesisPrompt…
- `lib/server/memory/ingest.ts` (7): extractText, extractToolState, extractOriginTodoID, extractChildSessionID, extractFilePaths, reindexRun…
- `lib/server/opencode-log-tail.ts` (7): defaultLogDir, fallbackWindowsLogDir, findActiveLog, isNoise, tickTail, discoveryTick…
- `components/chat-pane.tsx` (7): ChatPane, ChatHeader, MessageRow, UserMessage, ThinkingBlock, AssistantMessage…
- `components/contracts-rail.tsx` (7): parseNote, deriveCounts, ContractsRail, ContractsListBody, wrap, Chip…
- `lib/server/council.ts` (6): recommendedDeliberationRounds, tokenizeForConvergence, meanPairwiseJaccard, extractLatestAssistantText, buildRoundPrompt, runCouncilRounds
- `lib/server/critic-loop.ts` (6): buildWorkerIntroPrompt, buildCriticIntroPrompt, buildReviewPrompt, buildRevisionPrompt, classifyCriticReply, runCriticLoopKickoff
- `components/phases-rail.tsx` (6): fmtMin, PhasesRail, PhasesScrollBody, PhaseHeader, DeliberationRowEl, SynthesisRowEl
- `components/run-provenance-drawer.tsx` (6): RunProvenanceDrawer, PhaseChip, CountPill, EventRow, tailID, classifyType

## Per-file complexity (top 20 by function count)

| File | Lines | Functions defined |
|---|---|---|
| lib/opencode/transform.ts | 1190 | 35 |
| components/icons.tsx | 263 | 33 |
| lib/opencode/live.ts | 1453 | 29 |
| lib/server/swarm-registry.ts | 868 | 23 |
| lib/server/blackboard/planner.ts | 1235 | 20 |
| components/retro-view.tsx | 732 | 20 |
| components/projects-matrix.tsx | 484 | 15 |
| components/ui/stats-stream.tsx | 389 | 15 |
| lib/server/map-reduce.ts | 786 | 14 |
| components/council-rail.tsx | 463 | 14 |
| components/new-run/sub-components.tsx | 484 | 14 |
| lib/server/memory/rollup.ts | 592 | 13 |
| components/map-rail.tsx | 491 | 13 |
| components/cost-dashboard.tsx | 424 | 12 |
| components/inspector/sub-components.tsx | 799 | 12 |
| lib/server/debate-judge.ts | 660 | 11 |
| components/board-rail.tsx | 624 | 11 |
| components/phases-rail.tsx | 466 | 11 |
| lib/playback-context.tsx | 168 | 10 |
| lib/server/memory/ingest.ts | 293 | 10 |

## Files importing from many places (high static fan-out)

| File | Import statements |
|---|---|
| app/page.tsx | 44 |
| app/api/swarm/run/route.ts | 18 |
| lib/server/blackboard/coordinator/dispatch.ts | 17 |
| components/swarm-timeline.tsx | 15 |
| components/new-run-modal.tsx | 14 |
| lib/server/blackboard/planner.ts | 13 |
| components/left-tabs.tsx | 13 |
| lib/server/blackboard/auto-ticker/tick.ts | 12 |
| components/inspector/sub-components.tsx | 12 |
| components/swarm-topbar.tsx | 12 |
| lib/server/deliberate-execute.ts | 10 |
| lib/server/map-reduce.ts | 10 |
| components/agent-roster.tsx | 10 |
| lib/server/blackboard/auto-ticker/tier-escalation.ts | 9 |
| components/board-rail.tsx | 9 |

## Direct import cycles (A imports B AND B imports A): 2

- `lib/server/blackboard/planner.ts` ⟷ `lib/server/degraded-completion.ts`
- `components/heat-rail.tsx` ⟷ `components/heat-rail/sub-components.tsx`

