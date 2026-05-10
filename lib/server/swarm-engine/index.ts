//
// Headless swarm engine — clean facade over the coordination runtime.
//
// Four primitives for any consumer: route handlers, CI webhook, headless CLI.
// Delegates to existing modules (swarm-registry, auto-ticker, blackboard,
// opencode-server). No file moves — the engine is a wrapper, not a rewrite.
//
// Pub-sub: `subscribe(swarmRunID, handler)` returns an unsubscribe function.
//
// See docs/COMPOSITE_PLAN.md Plan C1.

import 'server-only';

import { createRun, getRun } from '../swarm-registry';
import { createSessionServer } from '../opencode-server';
import { startAutoTicker, stopAutoTicker } from '../blackboard/auto-ticker';
import type { SwarmRunMeta, SwarmRunRequest } from '../../swarm-run-types';

// ─── Event bus ───────────────────────────────────────────────────────

export type SwarmEngineEvent =
  | { type: 'run.created'; swarmRunID: string; meta: SwarmRunMeta }
  | { type: 'run.stopped'; swarmRunID: string; reason: string }
  | { type: 'planner.error'; swarmRunID: string; error: string };

type EventHandler = (event: SwarmEngineEvent) => void;

const BUS_KEY = Symbol.for('opencode_swarm.engine.eventBus');

function bus(): Map<string, Set<EventHandler>> {
  const g = globalThis as { [BUS_KEY]?: Map<string, Set<EventHandler>> };
  if (!g[BUS_KEY]) g[BUS_KEY] = new Map();
  return g[BUS_KEY]!;
}

function emit(swarmRunID: string, event: SwarmEngineEvent): void {
  for (const h of bus().get(swarmRunID) ?? []) {
    try { h(event); } catch { /* isolate subscriber errors */ }
  }
}

// ─── Engine singleton ────────────────────────────────────────────────

const ENGINE_KEY = Symbol.for('opencode_swarm.engine.singleton.v2');

export interface SwarmEngine {
  startRun(config: SwarmRunRequest): Promise<{ swarmRunID: string; meta: SwarmRunMeta }>;
  stopRun(swarmRunID: string): Promise<void>;
  subscribe(swarmRunID: string, handler: EventHandler): () => void;
  getRunMeta(swarmRunID: string): Promise<SwarmRunMeta | null>;
}

function createSwarmEngine(): SwarmEngine {
  return {
    async startRun(config) {
      const pattern = config.pattern ?? 'blackboard';
      const teamSize = config.teamSize ?? 2;

      // Create opencode sessions in parallel
      const spawnResults = await Promise.allSettled(
        Array.from({ length: teamSize }, (_, idx) =>
          createSessionServer(config.workspace)
        ),
      );
      const sessionIDs: string[] = [];
      for (const r of spawnResults) {
        if (r.status === 'fulfilled') sessionIDs.push(r.value.id);
      }

      if (sessionIDs.length === 0) {
        throw new Error('failed to create any opencode sessions');
      }

      // Persist the run
      const teamModels = config.teamModels;
      const created = await createRun(config, sessionIDs, { teamModels });
      const swarmRunID = created.swarmRunID;
      const meta = created;

      // Start auto-ticker for board-backed patterns
      if (pattern === 'blackboard' || pattern === 'orchestrator-worker') {
        const sweepMinutes = config.persistentSweepMinutes ?? 10;
        const periodicSweepMs = sweepMinutes > 0 ? Math.round(sweepMinutes * 60_000) : 0;
        startAutoTicker(swarmRunID, { periodicSweepMs });

        // Fire the kickoff planner sweep
        const { runBlackboardKickoff } = await import('../run/kickoff/blackboard');
        void runBlackboardKickoff(swarmRunID, {
          persistentSweepMinutes: sweepMinutes,
        }).catch((err: Error) => {
          emit(swarmRunID, {
            type: 'planner.error',
            swarmRunID,
            error: err.message,
          });
        });
      }

      emit(swarmRunID, { type: 'run.created', swarmRunID, meta });
      return { swarmRunID, meta };
    },

    async stopRun(swarmRunID) {
      stopAutoTicker(swarmRunID, 'manual');
      emit(swarmRunID, { type: 'run.stopped', swarmRunID, reason: 'manual' });
    },

    subscribe(swarmRunID, handler) {
      const b = bus();
      if (!b.has(swarmRunID)) b.set(swarmRunID, new Set());
      b.get(swarmRunID)!.add(handler);
      return () => b.get(swarmRunID)?.delete(handler);
    },

    async getRunMeta(swarmRunID) {
      return getRun(swarmRunID);
    },
  };
}

export function swarmEngine(): SwarmEngine {
  const g = globalThis as { [ENGINE_KEY]?: SwarmEngine };
  if (!g[ENGINE_KEY]) g[ENGINE_KEY] = createSwarmEngine();
  return g[ENGINE_KEY]!;
}
