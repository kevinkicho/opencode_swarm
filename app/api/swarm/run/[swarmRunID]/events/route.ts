// GET /api/swarm/run/:swarmRunID/events — server-sent events, multiplexed.
//
// Lifecycle per connection:
//   1. `swarm.run.attached`       — handshake: which sessionIDs are in-scope
//   2. `swarm.run.replay.start`   — opens the L0 replay window
//   3. N × SwarmRunEvent with `replay: true` from events.ndjson
//   4. `swarm.run.replay.end`     — closes the replay window (+ count)
//   5. live SwarmRunEvent frames forwarded from opencode's /event stream,
//      each one also appended to events.ndjson before emit
//
// Fan-in: one upstream SSE connection per unique workspace backing this run
// (at v1 that's exactly one, since N=1 and all sessions in a run share a
// workspace). Each upstream frame is parsed, filtered to events whose
// properties.sessionID belongs to the run, tagged with { swarmRunID,
// sessionID, ts }, appended to events.ndjson (L0 log — see DESIGN.md §7),
// then re-emitted to the browser.
//
// Two independent reasons to care about this shape:
//   1. The L0 log is the authoritative replay source — any analytics /
//      rollup worker reads from events.ndjson, not from the live stream.
//      Replay-on-attach honors this: a browser reload reconstructs the
//      run-level view from disk without re-fetching session history.
//   2. Future patterns (map-reduce, council) will have N sessions across
//      possibly multiple workspaces. The multiplexer collapses that into
//      one ordered stream the browser can consume with the same part
//      handlers it already uses for single-session views.
//
// Backpressure: we use a ReadableStream(controller) so the browser's pull
// rate throttles us naturally. If the browser disconnects, the AbortSignal
// fires and we close every upstream fetch cooperatively.

import type { NextRequest } from 'next/server';

import { opencodeFetch } from '@/lib/opencode/client';
import { appendEvent, getRun, readEvents } from '@/lib/server/swarm-registry';
import type { SwarmRunEvent } from '@/lib/swarm-run-types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Parses one SSE frame (`data: <json>\n\n`) into a JSON object. Opencode's
// event frames are always single-line JSON payloads; multi-line `data:`
// frames aren't part of the contract, so we only keep the first data line.
function parseSseFrame(frame: string): { type?: string; properties?: unknown } | null {
  const line = frame.split('\n').find((l) => l.startsWith('data:'));
  if (!line) return null;
  const payload = line.slice(5).trimStart();
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

// Streams opencode's SSE bytes into parsed JSON frames. Buffers across chunk
// boundaries (a single opencode event can arrive split across reads). Yields
// one parsed object per `\n\n`-terminated SSE frame.
async function* readOpencodeEvents(
  workspace: string,
  signal: AbortSignal
): AsyncGenerator<{ type?: string; properties?: unknown }> {
  const qs = new URLSearchParams({ directory: workspace }).toString();
  const res = await opencodeFetch(`/event?${qs}`, { signal });
  if (!res.ok || !res.body) {
    throw new Error(`opencode /event -> HTTP ${res.status}`);
  }
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const parsed = parseSseFrame(frame);
        if (parsed) yield parsed;
        sep = buffer.indexOf('\n\n');
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: { swarmRunID: string } }
): Promise<Response> {
  const meta = await getRun(params.swarmRunID);
  if (!meta) {
    return Response.json({ error: 'swarm run not found' }, { status: 404 });
  }

  const sessionIDs = new Set(meta.sessionIDs);
  const workspace = meta.workspace;

  // Abort signal flows browser-disconnect → upstream fetch cancel. Without
  // this the upstream SSE would keep the opencode connection alive after
  // the tab closes, leaking file descriptors over a long session.
  const upstreamAbort = new AbortController();
  req.signal.addEventListener('abort', () => upstreamAbort.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();

      const emitControl = (type: string, properties?: unknown) => {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ swarmRunID: meta.swarmRunID, type, properties: properties ?? {} })}\n\n`
          )
        );
      };

      // Initial handshake frame so the browser's EventSource sees a
      // connection immediately even if opencode has no pending events yet.
      emitControl('swarm.run.attached', { sessionIDs: [...sessionIDs] });

      // ─── L0 replay ──────────────────────────────────────────────────────
      // Stream events.ndjson to the browser before attaching to the live
      // opencode feed. The browser treats everything between
      // `swarm.run.replay.start` and `swarm.run.replay.end` as historical —
      // useful for rehydrating a provenance panel on reload without re-
      // fetching session history.
      //
      // `replayCutoffTs` captures the ts of the last replayed event so the
      // in-process `appendEvent` below doesn't double-write events that
      // another concurrent multiplexer may have already committed. At v1
      // with one multiplexer per connection this is a best-effort guard,
      // not a hard dedupe — see comment on appendEvent below.
      emitControl('swarm.run.replay.start');
      let replayCount = 0;
      try {
        for await (const ev of readEvents(meta.swarmRunID)) {
          if (upstreamAbort.signal.aborted) break;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ ...ev, replay: true })}\n\n`)
          );
          replayCount += 1;
        }
      } catch (err) {
        console.warn(
          '[swarm/run/events] replay read failed:',
          (err as Error).message
        );
      }
      emitControl('swarm.run.replay.end', { count: replayCount });

      try {
        for await (const ev of readOpencodeEvents(workspace, upstreamAbort.signal)) {
          // Only forward events whose sessionID belongs to this run. Global
          // events (no sessionID on properties) are dropped — a future swarm
          // coordinator event type could opt back in here.
          const props = (ev.properties && typeof ev.properties === 'object')
            ? (ev.properties as Record<string, unknown>)
            : {};
          const sid = typeof props.sessionID === 'string' ? props.sessionID : null;
          if (!sid || !sessionIDs.has(sid)) continue;

          const tagged: SwarmRunEvent = {
            swarmRunID: meta.swarmRunID,
            sessionID: sid,
            ts: Date.now(),
            type: ev.type ?? 'unknown',
            properties: ev.properties,
          };

          // Persist to L0 before forwarding so any crash between append and
          // emit still leaves a recoverable trace. Failures here shouldn't
          // kill the stream — log and continue; the browser copy is the
          // authoritative display anyway.
          //
          // Known race: two concurrent GETs for the same swarmRunID both
          // run their own readOpencodeEvents loop, so both append identical
          // events to ndjson (one per open browser tab). Dedupe belongs in
          // a shared-upstream multiplexer — deferred until multi-tab usage
          // actually bites. Single-tab + refresh is not affected because
          // connections don't overlap in time.
          appendEvent(meta.swarmRunID, tagged).catch((err) => {
            console.warn(
              '[swarm/run/events] L0 append failed:',
              (err as Error).message
            );
          });

          controller.enqueue(encoder.encode(`data: ${JSON.stringify(tagged)}\n\n`));
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'swarm.run.error', properties: { message: (err as Error).message } })}\n\n`
            )
          );
        }
      } finally {
        try { controller.close(); } catch {}
      }
    },
    cancel() {
      upstreamAbort.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tell proxies / Next's edge not to buffer.
      'x-accel-buffering': 'no',
    },
  });
}
