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
//
// 2026-04-28 decomposition: the four sections + their shared chrome
// moved to components/diagnostics/sections.tsx. This file is now the
// modal scaffolding only.

import { Modal } from './ui/modal';
import {
  ToolCatalogSection,
  McpServersSection,
  ConfigSection,
  CommandsSection,
} from './diagnostics/sections';

export function DiagnosticsModal({
  open,
  onClose,
  directory,
}: {
  open: boolean;
  onClose: () => void;
  directory: string | null;
}) {
  // Hard-bail when closed so the section components — and their
  // polling hooks — never mount. AnimatePresence in <Modal> already
  // skips children when open=false, but returning null at the top
  // also skips React's per-render JSX evaluation overhead and
  // eliminates any chance of useQuery instances being created and
  // immediately disabled. Belt + suspenders against tab-perf
  // regressions in long-lived sessions.
  if (!open) return null;
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
