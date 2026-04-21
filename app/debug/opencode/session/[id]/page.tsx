import Link from 'next/link';
import {
  getSessionMessages,
  opencodeBaseUrl,
  type OpencodeMessage,
  type OpencodePart,
} from '@/lib/opencode/client';

export const dynamic = 'force-dynamic';

type ProbeResult =
  | { ok: true; messages: OpencodeMessage[] }
  | { ok: false; error: string };

async function probe(id: string): Promise<ProbeResult> {
  try {
    const messages = await getSessionMessages(id);
    return { ok: true, messages };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function partSummary(part: OpencodePart): { label: string; body?: string } {
  switch (part.type) {
    case 'text':
      return { label: 'text', body: part.text };
    case 'reasoning':
      return { label: 'reasoning', body: part.text };
    case 'tool': {
      const name = typeof part.tool === 'string' ? part.tool : '—';
      return { label: `tool · ${name}` };
    }
    case 'step-start':
      return { label: 'step-start' };
    case 'step-finish':
      return { label: 'step-finish' };
    default:
      return { label: (part as { type?: string }).type ?? 'unknown' };
  }
}

function roleColor(role: 'user' | 'assistant'): string {
  return role === 'user' ? 'text-mint' : 'text-iris';
}

export default async function OpencodeSessionDebugPage({
  params,
}: {
  params: { id: string };
}) {
  const result = await probe(params.id);

  return (
    <main className="min-h-screen bg-ink-950 text-fog-200 font-mono p-8">
      <div className="max-w-[1100px] mx-auto space-y-6">
        <header className="space-y-1">
          <div className="text-micro uppercase tracking-widest2 text-fog-600">
            <Link href="/debug/opencode" className="hover:text-fog-300">
              debug / opencode
            </Link>
            <span className="text-fog-700"> / session / </span>
            <span className="text-fog-400">{params.id.slice(0, 12)}</span>
          </div>
          <h1 className="text-lg text-fog-100">messages</h1>
          <div className="text-[11px] text-fog-600">
            source: <span className="text-fog-400">{opencodeBaseUrl()}</span>
            <span className="text-fog-700"> · session </span>
            <span className="text-fog-400">{params.id}</span>
          </div>
        </header>

        {!result.ok ? (
          <section className="rounded hairline bg-rust/10 border border-rust/30 p-3 space-y-1">
            <div className="text-[12px] text-rust">fail</div>
            <div className="text-[11px] text-fog-300 break-all">{result.error}</div>
          </section>
        ) : (
          <section className="space-y-2">
            <div className="text-micro uppercase tracking-widest2 text-fog-600">
              messages · {result.messages.length}
            </div>
            <ul className="space-y-3">
              {result.messages.map((m) => (
                <li
                  key={m.info.id}
                  className="hairline rounded bg-ink-900/40 overflow-hidden"
                >
                  <div className="px-3 h-6 flex items-center gap-3 bg-ink-900/60">
                    <span
                      className={`text-[10px] uppercase tracking-widest2 w-16 ${roleColor(m.info.role)}`}
                    >
                      {m.info.role}
                    </span>
                    <span className="text-[10px] uppercase tracking-widest2 text-fog-700 w-24 truncate">
                      {m.info.agent ?? '—'}
                    </span>
                    <span className="text-[10px] text-fog-600 truncate flex-1 min-w-0">
                      {m.info.modelID
                        ? `${m.info.providerID ?? '—'} · ${m.info.modelID}`
                        : '—'}
                    </span>
                    <span className="text-[10px] text-fog-700 tabular-nums">
                      {fmtTime(m.info.time.created)}
                    </span>
                    <span className="text-[10px] text-fog-700 tabular-nums">
                      {m.info.id.slice(0, 7)}
                    </span>
                  </div>
                  <ul className="divide-y divide-ink-800">
                    {m.parts.map((part, i) => {
                      const s = partSummary(part);
                      return (
                        <li key={i} className="px-3 py-1.5 flex gap-3">
                          <span className="text-[10px] uppercase tracking-widest2 text-fog-700 w-28 shrink-0 pt-0.5">
                            {s.label}
                          </span>
                          {s.body ? (
                            <pre className="text-[11.5px] text-fog-200 whitespace-pre-wrap break-words flex-1 min-w-0 font-mono">
                              {s.body}
                            </pre>
                          ) : (
                            <span className="text-[11px] text-fog-600 italic">
                              (no text body)
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
