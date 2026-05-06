# Roadmap

Top 6 next features (priority order):

1. Deterministic mock harness: HTTP interceptor matching request patterns to fixture responses — hard gate for all pattern testing, ships first because reproducibility is the credibility foundation
2. Typed Pattern interface and PatternRegistry: lifecycle contract (init, step, shouldTerminate, onResult) with typed schemas and declarative dispatch — the keystone abstraction every other feature depends on
3. Blackboard pattern as first full vertical slice: implementation, mock data, integration test, and trace output all passing — proves the harness and Pattern interface work end-to-end before adding more patterns
4. Pattern execution tracer: structured event log capturing agent turns, state transitions, and termination reasons with deterministic replay — the capability where AutoGen and CrewAI fall down hardest, and the real product moat
5. Declarative pattern composition: a small DSL or config format for nesting patterns without imperative glue code — turns composability from a developer burden into a framework guarantee
6. Remaining patterns (council, orchestrator-worker, debate-judge, critic-loop, map-reduce) one at a time: each as a complete vertical slice with implementation, tests, and trace validation — no parallel partial implementations
