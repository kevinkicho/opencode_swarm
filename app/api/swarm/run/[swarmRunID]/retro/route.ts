// GET /api/swarm/run/:swarmRunID/retro
//
// Post-hoc run review computed from board items. Groups work by agent,
// counts done/stale per agent, and surfaces files touched. No external
// opencode calls — pure board-derived snapshot.

import type { NextRequest } from 'next/server';

import { getRun } from '@/lib/server/swarm-registry';
import { listBoardItems } from '@/lib/server/blackboard/store';
import type { BoardItem } from '@/lib/blackboard/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface AgentRetro {
  sessionID: string;
  name: string;
  todosCompleted: number;
  todosStale: number;
  filesEdited: string[];
}

interface RunRetro {
  swarmRunID: string;
  pattern: string;
  costTotal: number;
  tokensTotal: number;
  todosCompleted: number;
  todosStale: number;
  criteriaMet: number;
  criteriaUnmet: number;
  agents: AgentRetro[];
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { swarmRunID: string } },
): Promise<Response> {
  const meta = await getRun(params.swarmRunID);
  if (!meta) {
    return Response.json({ error: 'swarm run not found' }, { status: 404 });
  }

  const items = listBoardItems(params.swarmRunID);

  const roleNames = meta.teamRoles ?? [];
  const sessionIDs = meta.sessionIDs;

  // Group items by ownerAgentId (skip unclaimed items).
  const byAgent = new Map<string, BoardItem[]>();
  for (const item of items) {
    if (!item.ownerAgentId) continue;
    const list = byAgent.get(item.ownerAgentId);
    if (list) list.push(item);
    else byAgent.set(item.ownerAgentId, [item]);
  }

  const agents: AgentRetro[] = [];
  let todosCompleted = 0;
  let todosStale = 0;
  let criteriaMet = 0;
  let criteriaUnmet = 0;

  for (const [sessionID, agentItems] of byAgent) {
    const done = agentItems.filter(
      (it) => it.kind === 'todo' && it.status === 'done',
    ).length;
    const stale = agentItems.filter(
      (it) => it.kind === 'todo' && it.status === 'stale',
    ).length;
    const filesSet = new Set<string>();
    for (const it of agentItems) {
      if (it.fileHashes) {
        for (const fh of it.fileHashes) filesSet.add(fh.path);
      }
    }
    const idx = sessionIDs.indexOf(sessionID);
    const name =
      roleNames[idx] ?? `Agent ${idx >= 0 ? idx + 1 : agents.length + 1}`;

    agents.push({
      sessionID,
      name,
      todosCompleted: done,
      todosStale: stale,
      filesEdited: [...filesSet].sort(),
    });

    todosCompleted += done;
    todosStale += stale;
  }

  // Count criteria globally (owner-agnostic — auditor verdicts).
  for (const item of items) {
    if (item.kind !== 'criterion') continue;
    if (item.status === 'done') criteriaMet++;
    else if (item.status === 'blocked') criteriaUnmet++;
  }

  return Response.json({
    swarmRunID: meta.swarmRunID,
    pattern: meta.pattern,
    costTotal: 0,
    tokensTotal: 0,
    todosCompleted,
    todosStale,
    criteriaMet,
    criteriaUnmet,
    agents,
  } satisfies RunRetro, { status: 200 });
}
