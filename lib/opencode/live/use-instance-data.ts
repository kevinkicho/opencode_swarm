'use client';

//
// Instance-level live hooks for the v1.14 supplementary surfaces:
// useLiveToolIds (live tool catalog), useLiveConfig (effective
// opencode.json), useLiveMcpStatus (MCP server status map),
// useLiveCommands (user-defined commands).
//
// All four are directory-scoped (?directory=) — opencode's instance
// middleware uses the directory query param to pick which workspace's
// effective state to return. Each hook expects the active swarm-run's
// workspace path to be passed in; pass null to skip.
//
// All four are cheap-to-fetch + low-churn: tool catalog only changes
// when opencode is upgraded, config only when the user edits
// opencode.json, MCP status changes on connect/disconnect, commands
// only when the user edits opencode.json. Default poll cadence is 30s
// — frequent enough to catch user edits, cheap enough not to thrash.

import { useQuery } from '@tanstack/react-query';

import {
  getCommandsBrowser,
  getConfigBrowser,
  getMcpStatusBrowser,
  getToolIdsBrowser,
} from './_fetchers';
import type {
  OpencodeCommand,
  OpencodeConfig,
  OpencodeMcpStatusMap,
  OpencodeToolIds,
} from '../types';

export const TOOL_IDS_QUERY_KEY = ['opencode', 'tool-ids'] as const;
export const CONFIG_QUERY_KEY = ['opencode', 'config'] as const;
export const MCP_STATUS_QUERY_KEY = ['opencode', 'mcp-status'] as const;
export const COMMANDS_QUERY_KEY = ['opencode', 'commands'] as const;

// Live tool-name catalog from `GET /experimental/tool/ids`. Returns the
// raw string array (includes the `invalid` sentinel — caller filters if
// they want a presentational list). 60s stale time matches the
// "barely-changes" cadence.
export function useLiveToolIds(directory: string | null): {
  data: OpencodeToolIds | null;
  error: string | null;
  loading: boolean;
} {
  const q = useQuery({
    queryKey: [...TOOL_IDS_QUERY_KEY, directory ?? ''] as const,
    queryFn: ({ signal }) => getToolIdsBrowser(directory!, { signal }),
    enabled: Boolean(directory),
    staleTime: 60_000,
    retry: false,
  });
  return {
    data: q.data ?? null,
    error: q.error ? (q.error as Error).message : null,
    loading: q.isLoading,
  };
}

// Effective opencode.json from `GET /config`. Same shape as the file the
// user edits, post-merge (defaults + user overrides + env). 30s stale
// time so user edits surface within ~30s without manual refresh.
export function useLiveConfig(directory: string | null): {
  data: OpencodeConfig | null;
  error: string | null;
  loading: boolean;
} {
  const q = useQuery({
    queryKey: [...CONFIG_QUERY_KEY, directory ?? ''] as const,
    queryFn: ({ signal }) => getConfigBrowser(directory!, { signal }),
    enabled: Boolean(directory),
    staleTime: 30_000,
    retry: false,
  });
  return {
    data: q.data ?? null,
    error: q.error ? (q.error as Error).message : null,
    loading: q.isLoading,
  };
}

// MCP server status map from `GET /mcp`. Polls every 10s — MCP servers
// can transition between connected / failed / needs-auth without any
// user action, so a tighter cadence keeps the modal accurate.
export function useLiveMcpStatus(directory: string | null): {
  data: OpencodeMcpStatusMap | null;
  error: string | null;
  loading: boolean;
} {
  const q = useQuery({
    queryKey: [...MCP_STATUS_QUERY_KEY, directory ?? ''] as const,
    queryFn: ({ signal }) => getMcpStatusBrowser(directory!, { signal }),
    enabled: Boolean(directory),
    refetchInterval: 10_000,
    retry: false,
  });
  return {
    data: q.data ?? null,
    error: q.error ? (q.error as Error).message : null,
    loading: q.isLoading,
  };
}

// User-defined commands from `GET /command`. Same cadence as config —
// commands live in opencode.json so they change on the same rhythm.
export function useLiveCommands(directory: string | null): {
  data: OpencodeCommand[] | null;
  error: string | null;
  loading: boolean;
} {
  const q = useQuery({
    queryKey: [...COMMANDS_QUERY_KEY, directory ?? ''] as const,
    queryFn: ({ signal }) => getCommandsBrowser(directory!, { signal }),
    enabled: Boolean(directory),
    staleTime: 30_000,
    retry: false,
  });
  return {
    data: q.data ?? null,
    error: q.error ? (q.error as Error).message : null,
    loading: q.isLoading,
  };
}
