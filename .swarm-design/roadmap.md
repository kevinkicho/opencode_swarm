# Roadmap

Top 7 next features (priority order):

1. Deterministic mock harness: HTTP interceptor matching request patterns to fixture responses — hard gate for all pattern testing, ships first because reproducibility is the credibility foundation
2. Typed Pattern interface and PatternRegistry: lifecycle contract (init, step, shouldTerminate, onResult) with typed schemas and declarative dispatch — the keystone abstraction every other feature depends on
3. Blackboard pattern with integration test contract: shared-state coordination proving the harness and Pattern interface work end-to-end — first live pattern, validates the entire stack
4. Pattern execution tracer: structured event log capturing agent turns, state transitions, and termination reasons with deterministic replay — the capability where AutoGen and CrewAI fall down hardest, and the real product moat
5. Declarative pattern composition: a small DSL or config format for nesting patterns (critic-loop inside orchestrator-worker, council feeding into debate-judge) without imperative glue code — turns composability from a developer burden into a framework guarantee
6. Council + debate-judge patterns: cooperative consensus and adversarial refinement with bounded termination — proves the framework handles both cooperative and competitive topologies through one interface
7. Termination guarantee verifier: static analysis that proves a composed pattern terminates within bounded steps, catching infinite loops before runtime — formal verification as product differentiator no other framework offers
