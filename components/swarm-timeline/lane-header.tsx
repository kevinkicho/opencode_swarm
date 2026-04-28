'use client';

// One agent-lane's column in the timeline's sticky header strip.
//
// Renders: the lane button (click to select), accent stripe, status
// dot + name row, role / provider chip row, and the LaneMeter
// (throughput + tokens + cost). Wraps the whole lane in a Tooltip
// that surfaces the deep stats (cost / tokens / sent / recv / live
// throughput).
//
// Lifted from swarm-timeline.tsx 2026-04-28 — the inner lane render
// inside the agentOrder.map() was 150 lines and obscured the surface
// flow of the timeline component. Extracted as a per-lane component
// so the parent's render reads as the layout, not the lane contents.

import clsx from 'clsx';
import type { Agent, AgentMessage } from '@/lib/swarm-types';
import { ProviderBadge } from '../provider-badge';
import { Tooltip } from '../ui/tooltip';
import { LaneMeter } from './sub-views';
import { compact } from '@/lib/format';
import {
  formatRate,
  laneThroughput,
} from '@/lib/playback-context';
import { computeAttention, statusCircle } from '@/lib/agent-status';

const LANE_WIDTH = 168;

const accentStripe: Record<Agent['accent'], string> = {
  molten: 'bg-molten',
  mint: 'bg-mint',
  iris: 'bg-iris',
  amber: 'bg-amber',
  fog: 'bg-fog-500',
};

const accentText: Record<Agent['accent'], string> = {
  molten: 'text-molten',
  mint: 'text-mint',
  iris: 'text-iris',
  amber: 'text-amber',
  fog: 'text-fog-400',
};

export function LaneHeaderCell({
  agent,
  active,
  backendStale,
  messages,
  clockSec,
  roleNames,
  onSelectAgent,
}: {
  agent: Agent;
  active: boolean;
  backendStale: boolean;
  messages: AgentMessage[];
  clockSec: number;
  roleNames?: ReadonlyMap<string, string>;
  onSelectAgent: (id: string) => void;
}) {
  const a = agent;
  const throughput = laneThroughput(a.id, messages, clockSec);
  const attention = computeAttention(a, messages);
  const circle = statusCircle(a, attention);

  return (
    <Tooltip
      side="bottom"
      wide
      content={
        <div className="space-y-1.5 min-w-[200px]">
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-fog-100">{a.name}</span>
          </div>
          <ProviderBadge provider={a.model.provider} label={a.model.label} size="sm" />
          {a.focus && (
            <div className="font-mono text-[10.5px] text-fog-500 leading-snug">
              {a.focus}
            </div>
          )}
          <div className="flex items-center gap-3 font-mono text-[10.5px] text-fog-600 tabular-nums">
            <span>${a.costUsed.toFixed(2)}</span>
            <span>{compact(a.tokensUsed)} tok</span>
            <span>sent {a.messagesSent}</span>
            <span>recv {a.messagesRecv}</span>
          </div>
          {(throughput.inRate > 0 || throughput.outRate > 0) && (
            <div className="pt-1.5 hairline-t space-y-0.5">
              <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
                live throughput
              </div>
              <div className="flex items-center gap-2 font-mono text-[10.5px] text-fog-300 tabular-nums">
                <span>out {formatRate(throughput.outRate)}/s</span>
                <span className="text-fog-500">{throughput.activeOut.length} active</span>
              </div>
              <div className="flex items-center gap-2 font-mono text-[10.5px] text-fog-300 tabular-nums">
                <span>in {formatRate(throughput.inRate)}/s</span>
                <span className="text-fog-500">{throughput.activeIn.length} active</span>
              </div>
            </div>
          )}
          <div className="hairline-t pt-1.5 font-mono text-[10.5px] text-fog-600 opacity-20">
            click lane to inspect
          </div>
        </div>
      }
    >
      <button
        onClick={() => onSelectAgent(a.id)}
        className={clsx(
          'shrink-0 text-left hairline-r transition relative w-full',
          active ? 'bg-ink-700/40' : 'hover:bg-ink-700/20',
        )}
        style={{ width: LANE_WIDTH }}
      >
        <span
          className={clsx(
            'absolute left-0 right-0 top-0 h-[2px]',
            accentStripe[a.accent],
            !active && 'opacity-70',
          )}
        />
        <div className="px-3 pt-2.5 pb-2">
          <div className="flex items-center gap-2">
            <span
              className={clsx(
                'w-1.5 h-1.5 rounded-full shrink-0',
                // When the backend is stale, drop the animation
                // and use a neutral dot color — an orange pulse
                // without a live SSE feed is disinformation. The
                // lane itself still renders (history is
                // useful); just the "live-looking" veneer
                // comes off.
                backendStale ? 'bg-fog-700' : circle.dot,
                backendStale ? undefined : circle.animation,
              )}
            />
            <span className="text-[12px] text-fog-100 truncate flex-1 min-w-0">
              {a.name}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 min-w-0">
            {a.focus && (
              <span
                className={clsx(
                  'font-mono text-micro tracking-wide truncate min-w-0 flex-1',
                  accentText[a.accent],
                  'opacity-70',
                )}
              >
                {a.focus}
              </span>
            )}
            {/* Role chip 2026-04-24: shows the session's role
                in the run (planner / worker-N / judge /
                generator-N / critic / orchestrator / member-N /
                mapper-N / synthesizer) when the pattern
                assigns one. Falls back to the provider name
                for `none` pattern or unmapped sessions. The
                full provider label still lives in the lane's
                hover tooltip above.

                Bugfix 2026-04-24 evening: roleNames is keyed
                by `ownerIdForSession(sid)` = `ag_ses_<sid8>`
                (the coordinator's owner-id convention), but
                `a.id` is `ag_<agentName>_<sid8>` (the
                display-id convention from agentIdFor). The
                two never matched. We derive the owner-id
                inline from `a.sessionID` to bridge them. */}
            {(() => {
              const ownerId = a.sessionID
                ? `ag_ses_${a.sessionID.slice(-8)}`
                : '';
              const role = roleNames?.get(ownerId);
              if (role) {
                return (
                  <span
                    className={clsx(
                      'shrink-0 inline-flex items-center h-4 px-1.5 rounded-sm',
                      'font-mono text-[9.5px] uppercase tracking-widest2 hairline',
                      accentText[a.accent],
                      'bg-ink-900/70',
                    )}
                    title={`role: ${role} · model: ${a.model.label} (${a.model.provider})`}
                  >
                    {role}
                  </span>
                );
              }
              return <ProviderBadge provider={a.model.provider} size="sm" clickable />;
            })()}
          </div>
          <LaneMeter
            throughput={throughput}
            tokens={a.tokensUsed}
            tokensIn={a.tokensIn}
            tokensOut={a.tokensOut}
            cost={a.costUsed}
          />
        </div>
        {active && (
          <span className="absolute left-0 right-0 bottom-0 h-[1px] bg-molten" />
        )}
      </button>
    </Tooltip>
  );
}
