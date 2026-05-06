'use client';

import { PermissionStrip } from '@/components/permission-strip';
import { ReconcileStrip } from '@/components/reconcile-strip';
import { SynthesisStrip } from '@/components/synthesis-strip';
import { JudgeVerdictStrip } from '@/components/judge-verdict-strip';
import { CriticVerdictStrip } from '@/components/critic-verdict-strip';
import { OrchestratorActionsStrip } from '@/components/orchestrator-actions-strip';
import type { Agent, AgentMessage } from '@/lib/swarm-types';
import type { SwarmRunMeta } from '@/lib/swarm-run-types';
import type { LivePermissions } from '@/lib/opencode/live';
import type { CostCapHook } from './use-cost-cap-block';

type RunStripsProps = {
  agents: Agent[];
  messages: AgentMessage[];
  swarmRunMeta: SwarmRunMeta | null;
  focusedMsgId: string | null;
  onFocus: (id: string) => void;
  permissions: LivePermissions;
  safePost: CostCapHook['safePost'];
};

export function RunStrips({
  agents,
  messages,
  swarmRunMeta,
  focusedMsgId,
  onFocus,
  permissions,
  safePost,
}: RunStripsProps) {
  return (
    <>
      <PermissionStrip
        pending={permissions.pending}
        onApprove={permissions.approve}
        onReject={permissions.reject}
        error={permissions.error}
      />
      <ReconcileStrip
        agents={agents}
        messages={messages}
        isMultiSession={
          swarmRunMeta?.pattern === 'council' &&
          (swarmRunMeta?.sessionIDs.length ?? 0) > 1
        }
        onFocus={onFocus}
        focusedMsgId={focusedMsgId}
        onCopyDraft={async (draft) => {
          const text = draft.body ?? draft.title ?? '';
          if (!text) return;
          try {
            await navigator.clipboard.writeText(text);
          } catch (err) {
            console.error('[reconcile/copy] clipboard blocked', err);
          }
        }}
        onForwardDraft={async (draft, agent) => {
          if (!swarmRunMeta) return;
          const body = (draft.body ?? draft.title ?? '').trim();
          if (!body) return;
          const text = [
            `The council has accepted ${agent.name}'s draft. Continuing from:`,
            '',
            body,
          ].join('\n');
          for (const sid of swarmRunMeta.sessionIDs) {
            const result = await safePost(
              sid,
              swarmRunMeta.workspace,
              text,
              undefined,
              'reconcile/forward',
            );
            if (!result.ok && result.capped) return;
          }
        }}
        onStartRoundTwo={async (drafts) => {
          if (!swarmRunMeta) return;
          const block = drafts
            .map(
              ({ agent, draft }) =>
                `--- ${agent.name} ---\n${(draft.body ?? draft.title ?? '').trim()}`,
            )
            .join('\n\n');
          const text = [
            'Round 2. Below are the Round-1 drafts from every council member.',
            'Revise your own response in light of the others, or state clearly',
            'which member\'s draft you accept and why. Respond now.',
            '',
            block,
          ].join('\n');
          for (const sid of swarmRunMeta.sessionIDs) {
            const result = await safePost(
              sid,
              swarmRunMeta.workspace,
              text,
              undefined,
              'reconcile/round2',
            );
            if (!result.ok && result.capped) return;
          }
        }}
      />

      <SynthesisStrip
        agents={agents}
        messages={messages}
        pattern={swarmRunMeta?.pattern ?? null}
        sessionCount={swarmRunMeta?.sessionIDs.length ?? 0}
        onFocus={onFocus}
        focusedMsgId={focusedMsgId}
      />

      <JudgeVerdictStrip
        agents={agents}
        messages={messages}
        meta={swarmRunMeta}
        onFocus={onFocus}
      />

      <CriticVerdictStrip
        agents={agents}
        messages={messages}
        meta={swarmRunMeta}
        onFocus={onFocus}
      />

      <OrchestratorActionsStrip
        agents={agents}
        messages={messages}
        meta={swarmRunMeta}
        onAction={async (actionID, prompt) => {
          if (!swarmRunMeta) return;
          const orchestratorSID = swarmRunMeta.sessionIDs[0];
          if (!orchestratorSID) return;
          await safePost(
            orchestratorSID,
            swarmRunMeta.workspace,
            prompt,
            undefined,
            `orchestrator-action/${actionID}`,
          );
        }}
      />
    </>
  );
}