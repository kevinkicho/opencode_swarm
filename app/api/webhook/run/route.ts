// POST /api/webhook/run
//
// Accepts GitHub-style pull-request webhook payloads. When a PR opens,
// derives a directive from the PR title + body and starts a blackboard
// swarm run against the workspace. When a PR closes or merges, stops the
// matching run's auto-ticker.
//
// WEBHOOK_SECRET env var enables SHA-256 HMAC validation via the
// X-Hub-Signature-256 header. Without it, the endpoint always returns 401.
//
// Persistence: one JSON file per run under .opencode_swarm/webhooks/
// storing the repo / branch mapping so close events can find and stop
// the correct run.

import type { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createRun } from '@/lib/server/swarm-registry';
import { createSessionServer } from '@/lib/server/opencode-server';
import { patternDefaults } from '@/lib/swarm-patterns';
import { startAutoTicker } from '@/lib/server/blackboard/auto-ticker';
import { runPlannerSweep } from '@/lib/server/blackboard/planner';
import { stopAutoTicker } from '@/lib/server/blackboard/auto-ticker';
import { listBoardItems } from '@/lib/server/blackboard/store';
import { OPENCODE_SWARM_ROOT } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface WebhookBody {
  event: string;
  repo: string;
  branch: string;
  prTitle: string;
  prBody: string;
  signature?: string;
}

interface WebhookRecord {
  swarmRunID: string;
  prNumber: string;
  repo: string;
}

function webhooksDir(): string {
  return path.join(OPENCODE_SWARM_ROOT, 'webhooks');
}

function webhookPath(swarmRunID: string): string {
  return path.join(webhooksDir(), `${swarmRunID}.json`);
}

function verifySignature(rawBody: string, signature: string): boolean {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return false;
  const prefix = 'sha256=';
  if (!signature.startsWith(prefix)) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  const received = signature.slice(prefix.length);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
  } catch {
    return false;
  }
}

function deriveDirective(title: string, body: string): string {
  // Security S2: strip injection delimiters from PR titles/bodies before
  // embedding them in the planner prompt. Prevents PR-based prompt injection.
  const sanitize = (s: string): string =>
    (s ?? '')
      .replace(/```[\s\S]*?```/g, '[code block removed]')
      .replace(/##\s*.*/g, '')
      .replace(/\[system\].*/gi, '')
      .replace(/IGNORE\s+(ALL\s+)?(PREVIOUS\s+)?INSTRUCTIONS/gi, '[filtered]')
      .replace(/OVERRIDE\s+DIRECTIVE/gi, '[filtered]')
      .slice(0, 500);

  const cleanTitle = sanitize(title).trim() || 'Untitled PR';
  const cleanBody = sanitize(body);
  const context = cleanBody ? `\n\nPR context: ${cleanBody}` : '';
  return `PR: ${cleanTitle}${context}`;
}

async function handlePrOpened(body: WebhookBody): Promise<Response> {
  const workspace = process.cwd();
  const directive = deriveDirective(body.prTitle, body.prBody);
  const teamSize = 3;
  const defaults = patternDefaults['blackboard'];
  const teamModels = defaults.teamModels?.(teamSize);

  const spawnResults = await Promise.allSettled(
    Array.from({ length: teamSize }, (_, idx) =>
      createSessionServer(workspace, idx === 0 ? `webhook ${body.repo}#${body.branch}` : undefined),
    ),
  );

  const survivors = spawnResults
    .map((r, idx) => ({ result: r, idx }))
    .filter(({ result }) => result.status === 'fulfilled')
    .map(({ result, idx }) => ({
      id: (result as PromiseFulfilledResult<Awaited<ReturnType<typeof createSessionServer>>>).value.id,
      idx,
    }));

  if (survivors.length === 0) {
    return Response.json(
      { error: 'failed to spawn any sessions' },
      { status: 502 },
    );
  }

  const sessionIDs = survivors.map((s) => s.id);
  const teamModelsSurvivors = teamModels
    ? survivors.map((s) => teamModels[s.idx])
    : undefined;

  const meta = await createRun(
    {
      pattern: 'blackboard',
      workspace,
      directive,
      teamSize,
      teamModels,
      enableAuditorGate: defaults.enableAuditorGate,
      source: body.repo,
    },
    sessionIDs,
    { teamModels: teamModelsSurvivors },
  );

  const swarmRunID = meta.swarmRunID;

  // Run the planner sweep + start auto-ticker via the blackboard kickoff path
  let tickerStarted = false;
  try {
    const sweepResult = await runPlannerSweep(swarmRunID);
    if (sweepResult.items.length > 0) {
      const DEFAULT_PERSISTENT_SWEEP_MINUTES = 5;
      const periodicSweepMs = Math.round(DEFAULT_PERSISTENT_SWEEP_MINUTES * 60_000);
      startAutoTicker(swarmRunID, { periodicSweepMs });
      tickerStarted = true;
    }
  } catch (err) {
    const boardItems = listBoardItems(swarmRunID);
    if (boardItems.length > 0) {
      const DEFAULT_PERSISTENT_SWEEP_MINUTES = 5;
      const periodicSweepMs = Math.round(DEFAULT_PERSISTENT_SWEEP_MINUTES * 60_000);
      startAutoTicker(swarmRunID, { periodicSweepMs });
      tickerStarted = true;
    }
  }

  // Persist the webhook-to-run mapping so close events can find this run
  await fs.mkdir(webhooksDir(), { recursive: true });
  const record: WebhookRecord = {
    swarmRunID,
    prNumber: body.branch,
    repo: body.repo,
  };
  await fs.writeFile(webhookPath(swarmRunID), JSON.stringify(record) + '\n');

  return Response.json({ swarmRunID, status: 'started', tickerStarted }, { status: 200 });
}

async function handlePrClosed(body: WebhookBody): Promise<Response> {
  let entries: string[];
  try {
    entries = await fs.readdir(webhooksDir());
  } catch {
    return Response.json({ status: 'not-found' }, { status: 404 });
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const filePath = path.join(webhooksDir(), entry);
    let record: WebhookRecord;
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      record = JSON.parse(content);
    } catch {
      continue;
    }
    if (record.repo === body.repo && record.prNumber === body.branch) {
      stopAutoTicker(record.swarmRunID, 'manual');
      return Response.json({ swarmRunID: record.swarmRunID, status: 'stopped' }, { status: 200 });
    }
  }

  return Response.json({ status: 'not-found' }, { status: 404 });
}

export async function POST(req: NextRequest): Promise<Response> {
  const rawBody = await req.text();

  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const headerSig = req.headers.get('x-hub-signature-256');
    if (!headerSig) {
      return Response.json({ error: 'missing x-hub-signature-256 header' }, { status: 401 });
    }
    if (!verifySignature(rawBody, headerSig)) {
      return Response.json({ error: 'invalid signature' }, { status: 401 });
    }
  } else {
    return Response.json({ error: 'WEBHOOK_SECRET not configured — webhook endpoint is inert' }, { status: 401 });
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  switch (body.event) {
    case 'pull_request.opened':
      return handlePrOpened(body);
    case 'pull_request.closed':
    case 'pull_request.merged':
      return handlePrClosed(body);
    default:
      return Response.json({ error: `unsupported event: ${body.event}` }, { status: 400 });
  }
}
