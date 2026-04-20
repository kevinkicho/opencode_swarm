'use client';

import clsx from 'clsx';
import { useState } from 'react';
import type { Agent } from '@/lib/swarm-types';
import { Modal } from './ui/modal';
import { ProviderBadge } from './provider-badge';
import { Tooltip } from './ui/tooltip';

interface RoutingRule {
  role: string;
  glyph: string;
  accent: string;
  preferredProvider: 'zen' | 'go' | 'byok';
  preferredModel: string;
  spendCap: number;
  fallbackEnabled: boolean;
  description: string;
}

const defaultRules: RoutingRule[] = [
  {
    role: 'orchestrator',
    glyph: 'C',
    accent: 'molten',
    preferredProvider: 'zen',
    preferredModel: 'opus-4.7',
    spendCap: 2.0,
    fallbackEnabled: true,
    description: 'premium for planning - highest reasoning',
  },
  {
    role: 'architect',
    glyph: 'A',
    accent: 'iris',
    preferredProvider: 'zen',
    preferredModel: 'sonnet-4.6',
    spendCap: 1.0,
    fallbackEnabled: true,
    description: 'balanced mapping + synthesis',
  },
  {
    role: 'coder',
    glyph: 'K',
    accent: 'mint',
    preferredProvider: 'go',
    preferredModel: 'qwen3.6',
    spendCap: 0.5,
    fallbackEnabled: true,
    description: 'cheap open-source for bulk edits',
  },
  {
    role: 'researcher',
    glyph: 'S',
    accent: 'amber',
    preferredProvider: 'go',
    preferredModel: 'kimi k2.5',
    spendCap: 0.5,
    fallbackEnabled: false,
    description: 'fetch + summarize cheap',
  },
  {
    role: 'reviewer',
    glyph: 'W',
    accent: 'fog',
    preferredProvider: 'zen',
    preferredModel: 'haiku-4.5',
    spendCap: 0.3,
    fallbackEnabled: true,
    description: 'fast verifier always cheap',
  },
];

export function RoutingModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [rules, setRules] = useState(defaultRules);
  const [autoRoute, setAutoRoute] = useState(true);
  const [escalate, setEscalate] = useState(true);

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="policy"
      eyebrowHint={<PolicyTooltip />}
      title="routing rules"
      width="max-w-2xl"
    >
      <div className="space-y-4">
        <div className="rounded-md hairline bg-ink-900/50 p-3 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500 mb-1">
              default behavior
            </div>
            <div className="text-[12.5px] text-fog-200 leading-snug">
              Orchestrator routes each subtask based on role. Cheaper providers used when the role's
              confidence tier allows it. Failed routes fall back to the next tier if enabled.
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Toggle
            checked={autoRoute}
            onChange={setAutoRoute}
            label="auto-route by role"
            hint="match preferred provider per role"
          />
          <Toggle
            checked={escalate}
            onChange={setEscalate}
            label="escalate on fail"
            hint="retry failures on zen tier"
          />
        </div>

        <div className="rounded-md hairline bg-ink-900/50 overflow-hidden">
          <div className="px-3 h-8 hairline-b flex items-center gap-3 text-fog-600">
            <span className="font-mono text-micro uppercase tracking-widest2 w-28">role</span>
            <span className="font-mono text-micro uppercase tracking-widest2 flex-1">
              preferred model
            </span>
            <span className="font-mono text-micro uppercase tracking-widest2 w-20 text-right">
              cap / task
            </span>
            <span className="font-mono text-micro uppercase tracking-widest2 w-16 text-right">
              fallback
            </span>
          </div>

          <ul>
            {rules.map((r, i) => (
              <li
                key={r.role}
                className="px-3 h-12 hairline-b last:border-b-0 flex items-center gap-3 hover:bg-ink-800/60 transition"
              >
                <div className="flex items-center gap-2 w-28">
                  <span
                    className={clsx(
                      'w-[3px] h-5 shrink-0',
                      r.accent === 'molten' && 'bg-molten',
                      r.accent === 'mint' && 'bg-mint',
                      r.accent === 'iris' && 'bg-iris',
                      r.accent === 'amber' && 'bg-amber',
                      r.accent === 'fog' && 'bg-fog-500'
                    )}
                  />
                  <span
                    className={clsx(
                      'font-mono text-2xs uppercase tracking-widest2',
                      r.accent === 'molten' && 'text-molten',
                      r.accent === 'mint' && 'text-mint',
                      r.accent === 'iris' && 'text-iris',
                      r.accent === 'amber' && 'text-amber',
                      r.accent === 'fog' && 'text-fog-300'
                    )}
                  >
                    {r.role}
                  </span>
                </div>

                <div className="flex-1 flex items-center gap-2 min-w-0">
                  <ProviderBadge
                    provider={r.preferredProvider}
                    label={r.preferredModel}
                    size="sm"
                  />
                  <Tooltip content={r.description} side="top">
                    <span className="font-mono text-micro text-fog-700 cursor-help underline decoration-dotted decoration-fog-800 underline-offset-[3px]">
                      why?
                    </span>
                  </Tooltip>
                </div>

                <span className="w-20 text-right font-mono text-2xs text-fog-200 tabular-nums">
                  ${r.spendCap.toFixed(2)}
                </span>

                <div className="w-16 flex items-center justify-end">
                  <Toggle
                    compact
                    checked={r.fallbackEnabled}
                    onChange={(v) => {
                      const copy = [...rules];
                      copy[i] = { ...r, fallbackEnabled: v };
                      setRules(copy);
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-center gap-2">
          <button className="h-8 px-3 rounded font-mono text-micro uppercase tracking-wider bg-ink-900 hairline text-fog-400 hover:border-ink-500 transition">
            reset defaults
          </button>
          <span className="font-mono text-micro text-fog-700">
            changes apply to next dispatched subtask
          </span>
          <button
            onClick={onClose}
            className="ml-auto h-8 px-4 rounded font-mono text-micro uppercase tracking-wider bg-molten/15 hover:bg-molten/25 text-molten border border-molten/30 transition"
          >
            save
          </button>
        </div>
      </div>
    </Modal>
  );
}

function PolicyTooltip() {
  return (
    <div className="space-y-2 w-[300px]">
      <div>
        <div className="font-mono text-micro uppercase tracking-widest2 text-molten">
          policy = declarative rules
        </div>
        <div className="font-mono text-[10.5px] text-fog-400 leading-snug mt-0.5">
          you describe constraints. the orchestrator obeys them on the next
          dispatch. saving here does not run anything.
        </div>
      </div>

      <div className="hairline-t pt-1.5">
        <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500 mb-1">
          cues this is config not action
        </div>
        <ul className="space-y-0.5 font-mono text-[10.5px] text-fog-400 leading-snug">
          <li>
            · verbs are <span className="text-fog-200">save</span> /{' '}
            <span className="text-fog-200">reset</span>, not{' '}
            <span className="text-fog-700 line-through">send</span> /{' '}
            <span className="text-fog-700 line-through">run</span>
          </li>
          <li>· toggles + form rows = persistent state</li>
          <li>· per-row $ caps = config records, not commands</li>
        </ul>
      </div>

      <div className="hairline-t pt-1.5">
        <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500 mb-1">
          when it takes effect
        </div>
        <div className="font-mono text-[10.5px] text-fog-400 leading-snug">
          applies to the{' '}
          <span className="text-fog-200">next dispatched subtask</span>.
          in-flight agents keep their original budgets. policy is not live
          remote control.
        </div>
      </div>

      <div className="hairline-t pt-1.5">
        <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500 mb-1">
          stays pure on purpose
        </div>
        <div className="font-mono text-[10.5px] text-fog-400 leading-snug">
          no force-redispatch or abort-all here. imperatives live in the spawn
          modal, agent inspector, and command palette. one panel, one contract.
        </div>
      </div>

      <div className="hairline-t pt-1.5">
        <div className="font-mono text-[9.5px] text-fog-700 leading-snug">
          analogs · IAM policy · terraform plan · k8s scheduler · cron · tax
          brackets
        </div>
      </div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  compact,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  hint?: string;
  compact?: boolean;
}) {
  const track = (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative shrink-0 h-4 w-7 rounded-full transition border',
        checked ? 'bg-molten/20 border-molten/40' : 'bg-ink-900 border-ink-600'
      )}
    >
      <span
        className={clsx(
          'absolute top-[1px] h-[10px] w-[10px] rounded-full transition-all',
          checked ? 'left-[14px] bg-molten' : 'left-[1px] bg-fog-500'
        )}
      />
    </button>
  );

  if (compact) return track;

  return (
    <div className="flex items-center gap-2.5 flex-1 rounded-md hairline bg-ink-900/50 p-2.5">
      {track}
      <div className="flex-1 min-w-0">
        {label && <div className="text-[12px] text-fog-100 leading-tight">{label}</div>}
        {hint && (
          <div className="font-mono text-micro text-fog-600 leading-tight mt-0.5">{hint}</div>
        )}
      </div>
    </div>
  );
}
