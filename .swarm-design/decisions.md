# Design Decisions

## 2026-05-04 · REST-first client architecture
The opencode-client is a typed HTTP client with interceptible transports, not an in-process SDK. This means the framework communicates with opencode over HTTP, making it language-agnostic in principle and naturally mockable for deterministic testing.

## 2026-05-04 · Patterns are defined by integration test contracts
Each multi-agent pattern (blackboard, council, etc.) is specified primarily through an integration test that asserts observable behavior — what turns appear, what state transitions happen, what the final output looks like. Tests are the specification, not an afterthought.

## 2026-05-04 · Mock harness as a prerequisite, not a nice-to-have
The mock-opencode HTTP harness is a hard dependency for pattern development. No pattern implementation should proceed without deterministic test infrastructure in place, as the entire value proposition is reproducible multi-agent coordination.

## 2026-05-05 · Pattern interface before pattern migration
The typed Pattern interface and PatternRegistry must be landed in isolation before any existing patterns are refactored to use them. Attempting both in one run is too large a scope and risks incomplete work on all fronts. The interface is the contract everything else depends on — ship it first, then migrate patterns one at a time.

## 2026-05-05 · Lifecycle methods as the pattern contract spine
Every pattern must implement init, step, shouldTerminate, and onResult as typed methods. This lifecycle is what makes patterns composable (a parent pattern can call a child pattern's lifecycle) and observable (each method transition is a traceable event). The interface definition is the single most important type in the codebase.
