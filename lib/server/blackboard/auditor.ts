// Contract auditor — Stage 2 declared-roles alignment.
//
// When a blackboard run opts in via `enableAuditorGate: true`, a dedicated
// auditor opencode session is spawned at run creation (alongside the
// optional critic / verifier sessions). The auto-ticker's audit cadence
// (see Stage 2.3) invokes `auditCriteria` every K commits + on tier
// escalation + at run-end; the auditor returns one verdict per pending
// criterion and the caller transitions each criterion's board-item
// status accordingly:
//
//   VERDICT: MET     → status `done`
//   VERDICT: UNMET   → status `blocked` (may flip to met on later audit)
//   VERDICT: WONT_DO → status `stale`   (auditor says criterion was misguided)
//
// Shape mirrors critic.ts — same per-run mutex, same fail-open semantics,
// same small-prompt-footprint philosophy — but works on a batch of
// criteria at once (N criteria in one prompt → N verdicts in one reply),
// since audit cadence is rare (every K commits, not every commit).
// Batching also matches how a human auditor reads a contract: holistically,
// not one criterion at a time.
//
// Design per user decisions (2026-04-24):
// - **Termination precedence.** "All criteria met" does NOT stop the run
//   — the ambition ratchet keeps climbing (see Stage 2.4). The auditor's
//   job is to report verdicts, not to gate termination.
// - **Refine-as-you-go.** The planner can author new criteria on later
//   sweeps (additive only — no rewrite of existing ones). The auditor
//   judges every pending criterion on each audit pass, including ones
//   added after prior audits.
// - **Fail-open.** If the auditor session 409s, times out, returns an
//   unparseable reply, or misses some criteria, those criteria stay
//   `open` for the next audit pass. Never block the run on an auditor
//   malfunction.

import 'server-only';

import {
  abortSessionServer,
  getSessionMessagesServer,
  postSessionMessageServer,
} from '../opencode-server';
import { waitForSessionIdle } from './coordinator';
import type { BoardItem } from '../../blackboard/types';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CRITERIA_PER_AUDIT = 20;
const MAX_RECENT_DONE = 30;
const MAX_CONTENT_CHARS = 300;

export type AuditVerdict = 'met' | 'unmet' | 'wont-do' | 'unclear';

export interface AuditInput {
  swarmRunID: string;
  auditorSessionID: string;
  workspace: string;
  directive: string | undefined;
  // Pending criteria to judge. Caller filters board.items down to
  // kind='criterion' AND status NOT IN ('done', 'stale') before this
  // call — auditor doesn't re-judge already-verdicted criteria.
  // Order matters: prompt numbers them 1..N and reply echoes the
  // numbers, so this array defines the index mapping.
  criteria: BoardItem[];
  // Compact summary of recent worker commits so the auditor has
  // context on what's been done toward the contract. Typically
  // populated from buildPlannerBoardContext's doneSummaries.
  recentDoneSummaries: string[];
  timeoutMs?: number;
  // Pinned model (2026-04-24). Passed as `model` on
  // postSessionMessageServer so the auditor runs on a specific
  // provider/model. Undefined → opencode default.
  auditorModel?: string;
}

export interface AuditResult {
  // One entry per criterion in the input array, same order.
  verdicts: Array<{
    criterionID: string;
    verdict: AuditVerdict;
    reason: string;
  }>;
  rawReply?: string;
}

// Per-run mutex. Same pattern + rationale as critic.ts's mutex:
// opencode won't accept concurrent prompts on the same session.
//
// the lock map mid-flight.
const AUDIT_LOCKS_KEY = Symbol.for('opencode_swarm.auditLocks.v1');
function auditLocks(): Map<string, Promise<unknown>> {
  const g = globalThis as { [AUDIT_LOCKS_KEY]?: Map<string, Promise<unknown>> };
  const slot = g[AUDIT_LOCKS_KEY];
  if (slot instanceof Map) return slot;
  const next = new Map<string, Promise<unknown>>();
  g[AUDIT_LOCKS_KEY] = next;
  return next;
}

async function withAuditLock<T>(
  swarmRunID: string,
  fn: () => Promise<T>,
): Promise<T> {
  const locks = auditLocks();
  const prior = locks.get(swarmRunID) ?? Promise.resolve();
  const next = prior.then(fn, fn) as Promise<T>;
  locks.set(swarmRunID, next);
  try {
    return await next;
  } finally {
    if (locks.get(swarmRunID) === next) {
      locks.delete(swarmRunID);
    }
  }
}

function truncateContent(s: string): string {
  return s.length > MAX_CONTENT_CHARS
    ? s.slice(0, MAX_CONTENT_CHARS - 1).trimEnd() + '…'
    : s;
}

function buildAuditPrompt(input: AuditInput): string {
  const { directive, criteria, recentDoneSummaries } = input;

  const criteriaList = criteria
    .slice(0, MAX_CRITERIA_PER_AUDIT)
    .map((c, i) => `  ${i + 1}. ${truncateContent(c.content)}`)
    .join('\n');
  const doneList =
    recentDoneSummaries.length === 0
      ? '  (no work completed on this run yet)'
      : recentDoneSummaries
          .slice(-MAX_RECENT_DONE)
          .map((s, i) => `  ${i + 1}. ${truncateContent(s)}`)
          .join('\n');

  return [
    'You are the contract auditor for an autonomous swarm run. Each message',
    'I send you is a self-contained audit request — do not carry context',
    'across messages. Your job: verdict each acceptance criterion below',
    'against the worker activity listed.',
    '',
    '## Mission',
    directive?.trim() || '(no directive recorded)',
    '',
    '## Acceptance criteria (verdict each, numbered)',
    criteriaList,
    '',
    '## Recent worker activity (completed todos)',
    doneList,
    '',
    '## Your reply format',
    'Reply with EXACTLY ONE LINE PER CRITERION above, in the same order,',
    'each line numbered to match. Use one of these verdict tokens:',
    '  MET      — clearly satisfied by the completed work shown above',
    '  UNMET    — not yet satisfied; could be met by future work',
    "  WONT_DO  — the criterion is misguided or no longer appropriate",
    '             (e.g. out of scope, subsumed by a later criterion,',
    "             or clearly below the current tier's ambition band)",
    '',
    'Template: `<N>. VERDICT: MET|UNMET|WONT_DO — <one-line reason>`',
    '',
    'Example for a 3-criterion audit:',
    '  1. VERDICT: MET — commits e9f2 and a4b1 land the /metrics endpoint',
    '  2. VERDICT: UNMET — no work yet on the export feature',
    '  3. VERDICT: WONT_DO — subsumed by criterion 5 on this audit pass',
    '',
    'No preamble, no tool calls, no exploration. Reply now with',
    `exactly ${Math.min(criteria.length, MAX_CRITERIA_PER_AUDIT)} lines.`,
  ].join('\n');
}

// Line-oriented verdict parser. Each line: `<N>. VERDICT: <tok> — <reason>`.
// Returns Map<index, {verdict, reason}>; missing indices are the caller's
// responsibility (fall-open to 'unclear').
const VERDICT_LINE_RE =
  /^\s*(\d+)\s*[.)]\s*VERDICT:\s*(MET|UNMET|WONT_DO|WONTDO|WONT-DO)\b\s*(?:[—:-]\s*(.+))?\s*$/i;

function parseVerdictBatch(
  text: string,
  criteriaCount: number,
): Map<number, { verdict: AuditVerdict; reason: string }> {
  const out = new Map<number, { verdict: AuditVerdict; reason: string }>();
  for (const line of text.split(/\r?\n/)) {
    const m = VERDICT_LINE_RE.exec(line);
    if (!m) continue;
    const idx = parseInt(m[1], 10) - 1;
    if (idx < 0 || idx >= criteriaCount) continue;
    const tokRaw = m[2].toUpperCase().replace(/[-_]/g, '');
    let verdict: AuditVerdict;
    if (tokRaw === 'MET') verdict = 'met';
    else if (tokRaw === 'UNMET') verdict = 'unmet';
    else verdict = 'wont-do'; // WONTDO / WONT_DO / WONT-DO all normalize here
    const reason = (m[3] ?? '').trim() || '(no reason given)';
    // Keep first parse per index — ignores duplicate lines from a
    // misbehaving auditor that re-numbers.
    if (!out.has(idx)) out.set(idx, { verdict, reason });
  }
  return out;
}

// Post a batch audit request to the shared auditor session and wait
// for N verdicts. Fail-open on every error: missing / unparseable
// verdicts come back as 'unclear' so the caller's transition logic
// can leave those criteria open for the next audit pass.
export async function auditCriteria(input: AuditInput): Promise<AuditResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const criteriaToJudge = input.criteria.slice(0, MAX_CRITERIA_PER_AUDIT);

  if (criteriaToJudge.length === 0) {
    return { verdicts: [] };
  }

  return withAuditLock(input.swarmRunID, async () => {
    try {
      const before = await getSessionMessagesServer(
        input.auditorSessionID,
        input.workspace,
      );
      const knownIDs = new Set(before.map((m) => m.info.id));
      const prompt = buildAuditPrompt(input);
      await postSessionMessageServer(
        input.auditorSessionID,
        input.workspace,
        prompt,
        { model: input.auditorModel },
      );

      const deadline = Date.now() + timeoutMs;
      const waited = await waitForSessionIdle(
        input.auditorSessionID,
        input.workspace,
        knownIDs,
        deadline,
      );
      if (!waited.ok) {
        try {
          await abortSessionServer(input.auditorSessionID, input.workspace);
        } catch {
          // best-effort
        }
        return {
          verdicts: criteriaToJudge.map((c) => ({
            criterionID: c.id,
            verdict: 'unclear' as AuditVerdict,
            reason: `auditor wait failed: ${waited.reason}`,
          })),
        };
      }
      // Take the LAST assistant message's concatenated text (same
      // pattern as critic.ts::reviewWorkerDiff).
      let replyText = '';
      for (const msg of waited.messages) {
        if (!waited.newIDs.has(msg.info.id)) continue;
        if (msg.info.role !== 'assistant') continue;
        const text = (msg.parts ?? [])
          .flatMap((p) => (p.type === 'text' ? [p.text] : []))
          .join('')
          .trim();
        if (text) replyText = text;
      }
      const parsed = parseVerdictBatch(replyText, criteriaToJudge.length);
      const verdicts = criteriaToJudge.map((c, i) => {
        const entry = parsed.get(i);
        if (!entry) {
          return {
            criterionID: c.id,
            verdict: 'unclear' as AuditVerdict,
            reason: `auditor reply missing or unparseable for item ${i + 1}`,
          };
        }
        return {
          criterionID: c.id,
          verdict: entry.verdict,
          reason: entry.reason,
        };
      });
      return { verdicts, rawReply: replyText };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        verdicts: criteriaToJudge.map((c) => ({
          criterionID: c.id,
          verdict: 'unclear' as AuditVerdict,
          reason: `auditor threw: ${message}`,
        })),
      };
    }
  });
}
