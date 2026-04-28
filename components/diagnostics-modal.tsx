'use client';

//
// Diagnostics modal — exposes the v1.14 instance-level surfaces:
// /experimental/tool/ids, /config, /mcp, /command. Read-only inspector;
// no actions. Triggered from the status rail (footer right side) via
// `modals.openers.diagnostics()`.
//
// Why exists: opencode's effective state is normally invisible to the
// user — they edit opencode.json + restart and trust the daemon. This
// modal makes "what is opencode actually running with" inspectable so
// debugging "why is this skill missing" / "is this MCP connected" /
// "why won't the tool catalog match" stops requiring a curl probe.

import clsx from 'clsx';
import { useMemo } from 'react';

import { Modal } from './ui/modal';
import { Tooltip } from './ui/tooltip';
import {
  useLiveCommands,
  useLiveConfig,
  useLiveMcpStatus,
  useLiveToolIds,
} from '@/lib/opencode/live';
import type { ToolName } from '@/lib/swarm-types';
import { toolMeta } from '@/lib/part-taxonomy';

// Static ToolName members for drift comparison. Keep in sync with the
// union — the test catches additions; this list catches removals.
const STATIC_TOOL_NAMES: ToolName[] = [
  'bash', 'read', 'write', 'edit', 'apply_patch',
  'grep', 'glob', 'codesearch',
  'webfetch', 'websearch',
  'todowrite', 'task', 'question', 'skill',
];

// `invalid` is a sentinel returned by /experimental/tool/ids — never
// rendered as a user-facing chip.
const TOOL_ID_BLACKLIST = new Set(['invalid']);

export function DiagnosticsModal({
  open,
  onClose,
  directory,
}: {
  open: boolean;
  onClose: () => void;
  directory: string | null;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="opencode v1.14 surfaces"
      eyebrowHint={
        <div className="space-y-0.5">
          <div className="font-mono text-[11px] text-fog-200">
            instance-level diagnostics
          </div>
          <div className="font-mono text-[10.5px] text-fog-600 max-w-72">
            tool catalog · effective config · MCP servers · user commands
            from the running opencode daemon (probed on the active workspace)
          </div>
        </div>
      }
      title="diagnostics"
      width="max-w-[1100px]"
    >
      {!directory ? (
        <div className="font-mono text-[12px] text-fog-500 text-center py-12">
          select a swarm run to scope diagnostics to its workspace
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <ToolCatalogSection directory={directory} />
          <McpServersSection directory={directory} />
          <ConfigSection directory={directory} />
          <CommandsSection directory={directory} />
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Tool catalog — live tool ids vs. our static ToolName union. Drift is a
// signal: opencode added or removed a tool we haven't tracked.

function ToolCatalogSection({ directory }: { directory: string }) {
  const { data: liveIds, error, loading } = useLiveToolIds(directory);

  const drift = useMemo(() => {
    if (!liveIds) return null;
    const liveSet = new Set(
      liveIds.filter((t) => !TOOL_ID_BLACKLIST.has(t)),
    );
    const staticSet = new Set<string>(STATIC_TOOL_NAMES);
    const onlyInLive: string[] = [];
    const onlyInStatic: string[] = [];
    for (const id of liveSet) if (!staticSet.has(id)) onlyInLive.push(id);
    for (const id of staticSet) if (!liveSet.has(id)) onlyInStatic.push(id);
    return { onlyInLive, onlyInStatic };
  }, [liveIds]);

  return (
    <Section
      title="tool catalog"
      count={liveIds?.filter((t) => !TOOL_ID_BLACKLIST.has(t)).length}
      eyebrow="GET /experimental/tool/ids"
      error={error}
      loading={loading}
    >
      {liveIds && (
        <>
          <div className="flex flex-wrap gap-1 p-2">
            {liveIds
              .filter((t) => !TOOL_ID_BLACKLIST.has(t))
              .map((id) => {
                const known = STATIC_TOOL_NAMES.includes(id as ToolName);
                const meta = known ? toolMeta[id as ToolName] : null;
                const hex = meta?.hex ?? '#7d8798';
                return (
                  <Tooltip
                    key={id}
                    side="top"
                    content={
                      meta ? (
                        <div className="space-y-0.5">
                          <div className="font-mono text-[10.5px] text-fog-200">
                            {meta.label}
                          </div>
                          <div className="font-mono text-[10px] text-fog-500">
                            {meta.blurb}
                          </div>
                        </div>
                      ) : (
                        <span className="font-mono text-[10.5px] text-amber">
                          unknown to ToolName — drift
                        </span>
                      )
                    }
                  >
                    <span
                      className={clsx(
                        'inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] uppercase tracking-widest2 border',
                        known ? '' : 'border-amber/40 bg-amber/10 text-amber',
                      )}
                      style={
                        known
                          ? {
                              color: hex,
                              borderColor: `${hex}55`,
                              backgroundColor: `${hex}10`,
                            }
                          : undefined
                      }
                    >
                      {id}
                    </span>
                  </Tooltip>
                );
              })}
          </div>
          {drift &&
            (drift.onlyInLive.length > 0 || drift.onlyInStatic.length > 0) && (
              <div className="hairline-t px-3 py-2 space-y-1">
                {drift.onlyInLive.length > 0 && (
                  <DriftRow
                    label="live only"
                    tone="amber"
                    items={drift.onlyInLive}
                    hint="add to ToolName + toolMeta"
                  />
                )}
                {drift.onlyInStatic.length > 0 && (
                  <DriftRow
                    label="static only"
                    tone="rust"
                    items={drift.onlyInStatic}
                    hint="opencode dropped — remove from ToolName"
                  />
                )}
              </div>
            )}
          {drift &&
            drift.onlyInLive.length === 0 &&
            drift.onlyInStatic.length === 0 && (
              <div className="hairline-t px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest2 text-mint/80">
                in sync
              </div>
            )}
        </>
      )}
    </Section>
  );
}

function DriftRow({
  label,
  tone,
  items,
  hint,
}: {
  label: string;
  tone: 'amber' | 'rust';
  items: string[];
  hint: string;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span
        className={clsx(
          'font-mono text-[9.5px] uppercase tracking-widest2 shrink-0',
          tone === 'amber' && 'text-amber',
          tone === 'rust' && 'text-rust',
        )}
      >
        {label}
      </span>
      <span className="font-mono text-[10.5px] text-fog-300 truncate flex-1">
        {items.join(', ')}
      </span>
      <span className="font-mono text-[9.5px] text-fog-700 shrink-0">{hint}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MCP servers — status map keyed by server name.

function McpServersSection({ directory }: { directory: string }) {
  const { data, error, loading } = useLiveMcpStatus(directory);
  const entries = useMemo(
    () => (data ? Object.entries(data) : []),
    [data],
  );
  return (
    <Section
      title="MCP servers"
      count={entries.length}
      eyebrow="GET /mcp"
      error={error}
      loading={loading}
    >
      {data && entries.length === 0 && (
        <EmptyHint>no MCP servers configured</EmptyHint>
      )}
      {data && entries.length > 0 && (
        <ul>
          {entries.map(([name, status]) => {
            const tone = mcpStatusTone(status.type);
            return (
              <li
                key={name}
                className="grid grid-cols-[1fr_auto] items-center gap-2 px-3 h-8 border-b border-ink-700 last:border-b-0"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={clsx(
                      'w-1.5 h-1.5 rounded-full shrink-0',
                      tone === 'mint' && 'bg-mint',
                      tone === 'amber' && 'bg-amber',
                      tone === 'rust' && 'bg-rust',
                      tone === 'fog' && 'bg-fog-600',
                    )}
                  />
                  <span className="font-mono text-[11.5px] text-fog-100 truncate">
                    {name}
                  </span>
                </div>
                <span
                  className={clsx(
                    'font-mono text-[10px] uppercase tracking-widest2 shrink-0',
                    tone === 'mint' && 'text-mint',
                    tone === 'amber' && 'text-amber',
                    tone === 'rust' && 'text-rust',
                    tone === 'fog' && 'text-fog-500',
                  )}
                >
                  {status.type}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function mcpStatusTone(t: string): 'mint' | 'amber' | 'rust' | 'fog' {
  if (t === 'connected') return 'mint';
  if (t === 'failed') return 'rust';
  if (t === 'needs-auth' || t === 'needs-client-registration') return 'amber';
  return 'fog'; // disabled, unknown
}

// ---------------------------------------------------------------------------
// Effective config — ConfigGet returns the full opencode.json post-merge.
// We only display the high-signal fields; unknown keys would just clutter.

function ConfigSection({ directory }: { directory: string }) {
  const { data, error, loading } = useLiveConfig(directory);
  return (
    <Section
      title="effective config"
      eyebrow="GET /config"
      error={error}
      loading={loading}
    >
      {data && (
        <dl className="px-3 py-1 grid grid-cols-[88px_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
          <ConfigRow k="theme" v={data.theme ?? '—'} />
          <ConfigRow k="log level" v={data.logLevel ?? 'INFO'} />
          <ConfigRow
            k="share"
            v={data.share ?? 'manual'}
            tone={data.share === 'disabled' ? 'mint' : data.share === 'auto' ? 'amber' : 'fog'}
          />
          <ConfigRow
            k="autoupdate"
            v={
              data.autoupdate === true
                ? 'on'
                : data.autoupdate === false
                  ? 'off'
                  : (data.autoupdate ?? 'notify')
            }
          />
          <ConfigRow k="snapshot" v={data.snapshot === false ? 'off' : 'on'} />
          <ConfigRow
            k="watcher"
            v={
              data.watcher?.ignore?.length
                ? `${data.watcher.ignore.length} ignore${
                    data.watcher.ignore.length === 1 ? '' : 's'
                  }`
                : '—'
            }
          />
          <ConfigRow
            k="plugins"
            v={data.plugin?.length ? `${data.plugin.length}` : '—'}
          />
        </dl>
      )}
    </Section>
  );
}

function ConfigRow({
  k,
  v,
  tone,
}: {
  k: string;
  v: string;
  tone?: 'mint' | 'amber' | 'rust' | 'fog';
}) {
  return (
    <>
      <dt className="text-fog-600 uppercase tracking-widest2 text-[9.5px] self-center">
        {k}
      </dt>
      <dd
        className={clsx(
          'tabular-nums truncate self-center',
          tone === 'mint' && 'text-mint',
          tone === 'amber' && 'text-amber',
          tone === 'rust' && 'text-rust',
          (!tone || tone === 'fog') && 'text-fog-200',
        )}
      >
        {v}
      </dd>
    </>
  );
}

// ---------------------------------------------------------------------------
// User-defined commands — pulled from opencode.json. Each command has a
// name, optional description, and a template the user can invoke.

function CommandsSection({ directory }: { directory: string }) {
  const { data, error, loading } = useLiveCommands(directory);
  return (
    <Section
      title="user commands"
      count={data?.length}
      eyebrow="GET /command"
      error={error}
      loading={loading}
    >
      {data && data.length === 0 && (
        <EmptyHint>no user-defined commands in opencode.json</EmptyHint>
      )}
      {data && data.length > 0 && (
        <ul>
          {data.map((cmd) => (
            <li
              key={cmd.name}
              className="grid grid-cols-[80px_1fr] gap-x-2 px-3 py-1.5 border-b border-ink-700 last:border-b-0"
            >
              <span className="font-mono text-[11px] uppercase tracking-widest2 text-molten truncate self-start mt-[1px]">
                {cmd.name}
              </span>
              <div className="min-w-0">
                {cmd.description && (
                  <div className="text-[12px] text-fog-200 leading-snug truncate">
                    {cmd.description}
                  </div>
                )}
                <div className="font-mono text-[10px] text-fog-600 truncate mt-0.5">
                  {cmd.agent && (
                    <span className="text-fog-500 mr-2">@{cmd.agent}</span>
                  )}
                  {cmd.model && (
                    <span className="text-fog-500 mr-2">{cmd.model}</span>
                  )}
                  {cmd.subtask && <span className="text-mint/70 mr-2">subtask</span>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Shared section wrapper — title row with count + eyebrow, then content,
// loading, or error.

function Section({
  title,
  count,
  eyebrow,
  error,
  loading,
  children,
}: {
  title: string;
  count?: number;
  eyebrow: string;
  error: string | null;
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md hairline bg-ink-800 overflow-hidden flex flex-col">
      <div className="px-3 h-8 hairline-b flex items-center gap-2 shrink-0">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-200">
          {title}
        </span>
        {typeof count === 'number' && (
          <span className="font-mono text-micro text-fog-600 tabular-nums">
            {count}
          </span>
        )}
        <span className="ml-auto font-mono text-[9.5px] text-fog-700">
          {eyebrow}
        </span>
      </div>
      <div className="flex-1 min-h-[80px]">
        {loading && !error && (
          <div className="font-mono text-[10.5px] text-fog-600 px-3 py-2">
            loading…
          </div>
        )}
        {error && (
          <div className="font-mono text-[10.5px] text-rust px-3 py-2">
            {error}
          </div>
        )}
        {!loading && !error && children}
      </div>
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[10.5px] text-fog-600 px-3 py-2 italic">
      {children}
    </div>
  );
}
