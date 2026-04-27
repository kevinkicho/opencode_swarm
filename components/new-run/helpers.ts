// Pure helpers + types extracted from new-run-modal.tsx as part of the
// 2026-04-26 component decomposition pass. Kept in their own file so
// the modal's tsx body doesn't have to scroll past constant tables and
// regex helpers to reach the actual JSX.

import type { SwarmPattern } from '@/lib/swarm-types';

export type BranchStrategy = 'push-same-branch' | 'push-new-branch' | 'local-only';
export type StartMode = 'dry-run' | 'live' | 'spectator';

export function generateRunId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `swarm-${id}`;
}

export function extractRepoName(url: string): string {
  const trimmed = url.trim().replace(/\.git$/, '').replace(/\/$/, '');
  if (!trimmed) return '';
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

// Curl-recipe reference shown in a collapsible block at the bottom of
// the modal. Docs-as-copy: each entry is a working example of POST
// /api/swarm/run for that pattern. Kept alongside the modal rather
// than in because discoverability matters here
// users see the tile grid and immediately ask "what does the API
// body look like?".
//
// Keep in sync with lib/server/<pattern>.ts and the route validator.
// If you add a new pattern, add a recipe here.
export const API_RECIPES: ReadonlyArray<{
  pattern: SwarmPattern;
  hint: string;
  body: string;
}> = [
  {
    pattern: 'blackboard',
    hint: 'coordinator-dispatched todos on a shared board',
    body: `curl -X POST http://localhost:49187/api/swarm/run -d '{
  "pattern": "blackboard",
  "workspace": "C:/Users/kevin/Workspace/<repo>",
  "directive": "Review and improve this codebase",
  "teamSize": 3,
  "persistentSweepMinutes": 20
}'`,
  },
  {
    pattern: 'orchestrator-worker',
    hint: 'one orchestrator plans + re-strategizes, n workers execute',
    body: `curl -X POST http://localhost:49187/api/swarm/run -d '{
  "pattern": "orchestrator-worker",
  "workspace": "C:/Users/kevin/Workspace/<repo>",
  "directive": "Achieve everything README claims",
  "teamSize": 4,
  "persistentSweepMinutes": 20
}'`,
  },
  {
    pattern: 'role-differentiated',
    hint: 'pinned specialties: architect, tester, security, …',
    body: `curl -X POST http://localhost:49187/api/swarm/run -d '{
  "pattern": "role-differentiated",
  "workspace": "C:/Users/kevin/Workspace/<repo>",
  "directive": "Build feature X end-to-end",
  "teamSize": 4,
  "teamRoles": ["architect","builder","tester","security"],
  "persistentSweepMinutes": 20
}'`,
  },
  {
    pattern: 'critic-loop',
    hint: 'worker drafts → critic reviews → loop to APPROVED',
    body: `curl -X POST http://localhost:49187/api/swarm/run -d '{
  "pattern": "critic-loop",
  "workspace": "C:/Users/kevin/Workspace/<repo>",
  "directive": "Write a design doc for the new pricing surface",
  "teamSize": 2,
  "criticMaxIterations": 3
}'`,
  },
  {
    pattern: 'debate-judge',
    hint: 'n generators propose, one judge picks or merges',
    body: `curl -X POST http://localhost:49187/api/swarm/run -d '{
  "pattern": "debate-judge",
  "workspace": "C:/Users/kevin/Workspace/<repo>",
  "directive": "Choose an approach for the auth rewrite",
  "teamSize": 4,
  "debateMaxRounds": 2
}'`,
  },
  {
    pattern: 'council',
    hint: 'n divergent drafts, auto round-2/3 exchange',
    body: `curl -X POST http://localhost:49187/api/swarm/run -d '{
  "pattern": "council",
  "workspace": "C:/Users/kevin/Workspace/<repo>",
  "directive": "Propose three approaches to X",
  "teamSize": 3
}'`,
  },
  {
    pattern: 'map-reduce',
    hint: 'split workspace into slices, synthesize at the end',
    body: `curl -X POST http://localhost:49187/api/swarm/run -d '{
  "pattern": "map-reduce",
  "workspace": "C:/Users/kevin/Workspace/<repo>",
  "directive": "Audit the codebase, per slice",
  "teamSize": 3
}'`,
  },
];

export interface Inferred {
  focus: string[];
  hotspots: string[];
  openWork: string[];
}

// Mocked "what the swarm would infer from the substrate" when directive is blank.
// In real wiring: reads README + recent commits + open issues + PR titles.
export const inferred: Inferred = {
  focus: ['reduce build time', 'stabilize flaky e2e', 'document public api'],
  hotspots: ['apps/web/src/lib/queue/**', 'packages/core/src/serializer.ts'],
  openWork: ['#412 race in ws reconnect', '#417 perf regression in /search'],
};
