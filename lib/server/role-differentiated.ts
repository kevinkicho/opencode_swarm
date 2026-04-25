// Role-differentiated pattern — hierarchical pattern #2 (see
// SWARM_PATTERNS.md §6).
//
// Shape: N workers, each with a pinned role (architect, tester,
// security, ux, …). Every session gets a role-framed intro + the
// opencode `agent` field set to the role name, so the roster shows
// role labels distinctly. Board dispatch is still any-can-claim
// (v1) — roles shape WHAT each agent self-selects via its role
// description, not HOW the coordinator routes. Adding a
// preferredRole field on board items is a natural v2 extension.
//
// Defaults: when teamRoles isn't provided, synth names "architect",
// "builder", "tester", "reviewer", ... pulling from a small template
// list. The template is opinionated but easy to override via
// teamRoles in the request body.

import { postSessionMessageServer } from './opencode-server';
import { startAutoTicker } from './blackboard/auto-ticker';
import { runPlannerSweep } from './blackboard/planner';
import { getRun, updateRunMeta } from './swarm-registry';

// Default roles in a small-team balance. Order matters — the first
// `teamSize` entries are used when teamRoles isn't provided.
const DEFAULT_ROLES: readonly string[] = [
  'architect',
  'builder',
  'tester',
  'reviewer',
  'security',
  'docs',
  'ux',
  'data',
];

// Normalize a role name for safe use as opencode's `agent` field:
// lowercase, kebab-case, alnum + hyphen only. Keeps the roster chip
// compact and prevents spaces / special chars from breaking opencode's
// routing on the agent name.
function normalizeRoleName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

export function resolveTeamRoles(
  sessionCount: number,
  provided: readonly string[] | undefined,
): string[] {
  if (provided && provided.length === sessionCount) {
    return provided.map(normalizeRoleName);
  }
  if (provided && provided.length !== sessionCount) {
    console.warn(
      `[role-differentiated] teamRoles length ${provided.length} != sessionCount ${sessionCount} — falling back to defaults`,
    );
  }
  // Cycle the default list if the team is larger than DEFAULT_ROLES.
  const out: string[] = [];
  for (let i = 0; i < sessionCount; i += 1) {
    out.push(DEFAULT_ROLES[i % DEFAULT_ROLES.length]);
  }
  return out;
}

function buildRoleIntroPrompt(
  role: string,
  allRoles: readonly string[],
  directive: string | undefined,
): string {
  const base =
    directive?.trim() ||
    'Achieve the mission implied by the project README.';
  const teamList = allRoles.map((r) => `  - ${r}`).join('\n');

  return [
    `You are the **${role}** on this team.`,
    '',
    `Full team roster (one session per role):`,
    teamList,
    '',
    `Mission: ${base}`,
    '',
    `Your role biases the work you self-select. A "${role}" naturally`,
    `gravitates toward work that fits that specialty — pick those todos`,
    `first when they're available on the board, but don't refuse other`,
    `work when the board needs help. Teammates will own their specialties`,
    `in return.`,
    '',
    'Sit tight until the planner sweep seeds todos. When the board has',
    'open items, claim one, implement it, and commit your changes. The',
    "blackboard's claim-and-work loop handles the mechanics; you just",
    'focus on the work itself.',
  ].join('\n');
}

export async function runRoleDifferentiatedKickoff(
  swarmRunID: string,
  opts: { persistentSweepMinutes?: number } = {},
): Promise<void> {
  const meta = await getRun(swarmRunID);
  if (!meta) {
    console.warn(
      `[role-differentiated] run ${swarmRunID} not found — kickoff aborted`,
    );
    return;
  }
  if (meta.pattern !== 'role-differentiated') {
    console.warn(
      `[role-differentiated] run ${swarmRunID} has pattern '${meta.pattern}', not role-differentiated — kickoff aborted`,
    );
    return;
  }
  if (meta.sessionIDs.length < 2) return;

  const roles = resolveTeamRoles(meta.sessionIDs.length, meta.teamRoles);

  // Persist resolved roles to meta so every downstream consumer
  // (roleNamesBySessionID, board chip labels, planner prompt role-tag
  // awareness, coordinator picker bias) sees the authoritative list —
  // not just the optional user-supplied one. Fire-and-forget: a failed
  // write doesn't stall the kickoff; next meta read may miss the roles
  // but the session intros still go out.
  if (!meta.teamRoles || meta.teamRoles.length !== roles.length) {
    updateRunMeta(swarmRunID, { teamRoles: roles }).catch((err) => {
      console.warn(
        `[role-differentiated] run ${swarmRunID}: teamRoles persist failed:`,
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  // Post role-framed intros to every session in parallel. Each intro sets
  // agent={role} so the opencode session carries the role label on all
  // subsequent assistant turns — surfaces in the roster via info.agent.
  // Sessions 1..N get a simple role intro; session 0 (by convention, the
  // first role = architect) gets NO intro here — the planner sweep below
  // serves as its first prompt and naturally kicks off the todowrite.
  // 2026-04-25 fix: dropped `agent: roles[i]`. Custom role names like
  // 'tester', 'builder', 'reviewer', 'security' aren't in opencode's
  // built-in agent list (build/compaction/explore/general/plan/summary
  // /title) and cause prompt_async to silently drop the user message.
  // Only 'architect' empirically dispatched correctly before this fix —
  // all other role intros were silently lost. Same root cause as the
  // POSTMORTEMS/2026-04-25-agent-name-silent-drop.md F1+F2 fixes.
  // Role display in our UI continues to work via roleNamesBySessionID.
  const results = await Promise.allSettled(
    meta.sessionIDs.slice(1).map((sid, idx) => {
      const i = idx + 1;
      return postSessionMessageServer(
        sid,
        meta.workspace,
        buildRoleIntroPrompt(roles[i], roles, meta.directive),
        { model: meta.teamModels?.[i] },
      );
    }),
  );
  results.forEach((r, idx) => {
    const i = idx + 1;
    if (r.status === 'rejected') {
      console.warn(
        `[role-differentiated] intro post failed for ${roles[i]} (${meta.sessionIDs[i].slice(-8)}):`,
        r.reason instanceof Error ? r.reason.message : String(r.reason),
      );
    }
  });
  console.log(
    `[role-differentiated] run ${swarmRunID}: posted role intros → ${roles.slice(1).join(', ')} (session 0 = ${roles[0]} handles planning)`,
  );

  // Planner sweep: session 0 IS the architect (first role). The planner
  // prompt lands on that session as its first message, and its role-flavor
  // is implicit via the architect framing already baked into the planner
  // prompt's tone. Producing todowrite is naturally what an architect
  // does first.
  try {
    const result = await runPlannerSweep(swarmRunID);
    if (result.items.length === 0) {
      console.warn(
        `[role-differentiated] run ${swarmRunID}: planner sweep produced 0 todos — auto-ticker NOT started`,
      );
      return;
    }
    console.log(
      `[role-differentiated] run ${swarmRunID}: planner sweep produced ${result.items.length} todos — starting auto-ticker`,
    );
  } catch (err) {
    console.warn(
      `[role-differentiated] run ${swarmRunID}: planner sweep failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  const periodicSweepMs =
    opts.persistentSweepMinutes && opts.persistentSweepMinutes > 0
      ? Math.round(opts.persistentSweepMinutes * 60_000)
      : 0;
  startAutoTicker(swarmRunID, { periodicSweepMs });
}
