'use client';

// Right-column preview panel for the spawn-agent modal.
//
// Read-only summary of the in-flight form state — name, mode, model
// badge, selected skills, directive preview — plus a "next step"
// footer explaining what spawn does and how built-ins interact with
// skills.
//
// Extracted from spawn-agent-modal.tsx 2026-04-28. Mirrors the
// new-run/preview-panel.tsx pattern: pure render, no state, props
// driven. Lifted because it's ~95 lines of read-only display markup
// the modal body doesn't need to scroll past every time the form
// shape evolves.

import clsx from 'clsx';
import { ProviderBadge } from '../provider-badge';
import type { ProviderModel } from '@/app/api/swarm/providers/route';
import type { SpawnMode } from './sub-components';

export interface SpawnSkill {
  id: string;
  name: string;
  auth: string;
}

export interface PreviewPanelProps {
  previewName: string;
  trimmedName: string;
  spawnMode: SpawnMode;
  currentModel: ProviderModel | undefined;
  selectedSkills: Set<string>;
  skills: SpawnSkill[];
  directive: string;
}

export function PreviewPanel({
  previewName,
  trimmedName,
  spawnMode,
  currentModel,
  selectedSkills,
  skills,
  directive,
}: PreviewPanelProps) {
  return (
    <aside className="min-w-0 flex flex-col gap-3">
      <div>
        <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600 mb-2">
          preview
        </div>
        <div className="relative rounded-md hairline bg-ink-900/60 overflow-hidden border border-molten/40">
          <div className="h-[3px] w-full bg-molten" />
          <div className="p-3 space-y-2.5">
            <div className="flex items-center gap-2">
              <span
                className={clsx(
                  'w-1.5 h-1.5 rounded-full',
                  spawnMode === 'active' ? 'bg-mint animate-pulse' : 'bg-molten'
                )}
              />
              <span
                className={clsx(
                  'text-[13px] truncate flex-1 min-w-0',
                  trimmedName ? 'text-fog-100' : 'text-fog-500 italic'
                )}
              >
                {previewName}
              </span>
              <span
                className={clsx(
                  'font-mono text-micro uppercase tracking-widest2',
                  spawnMode === 'active' ? 'text-mint' : 'text-fog-700'
                )}
              >
                {spawnMode}
              </span>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {currentModel && (
                <ProviderBadge provider={currentModel.provider} label={currentModel.label} size="sm" />
              )}
            </div>

            <div className="pt-1 hairline-t">
              <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600 mb-1.5 mt-1.5">
                skills
              </div>
              {selectedSkills.size === 0 ? (
                <div className="text-[11.5px] text-fog-700 italic font-mono">
                  none built-ins only
                </div>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {skills
                    .filter((s) => selectedSkills.has(s.id))
                    .map((s) => (
                      <span
                        key={s.id}
                        className="inline-flex items-center h-4 px-1.5 text-[9px] border rounded-[3px] font-mono tracking-wider uppercase border-ink-500 bg-ink-800 text-fog-300"
                      >
                        {s.name}
                      </span>
                    ))}
                </div>
              )}
            </div>

            <div className="pt-1 hairline-t">
              <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600 mb-1.5 mt-1.5">
                directive
              </div>
              <div className="text-[11.5px] text-fog-500 leading-relaxed font-mono">
                {directive.trim() ? (
                  <>
                    {directive.slice(0, 160)}
                    {directive.length > 160 ? '...' : ''}
                  </>
                ) : (
                  <span className="text-fog-700 italic">
                    no brief agent will roam and self-negotiate scope
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-md hairline bg-ink-900/40 p-3 space-y-1.5">
        <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
          next step
        </div>
        <div className="text-[11px] text-fog-400 leading-snug">
          Agent enters the roster in {spawnMode} mode. Every model inherits
          opencode's built-in tools (read, edit, bash, grep, task ...) for
          free. Skills add credentialed integrations on top.
        </div>
      </div>
    </aside>
  );
}
