'use client';

import clsx from 'clsx';
import { useRef, useState } from 'react';
import type { ChatMessage } from '@/lib/types';
import { IconUser, IconThinking, IconSpark, toolIcon } from './icons';

export function ChatPane({
  messages,
  onToolClick,
  focusedNodeId,
}: {
  messages: ChatMessage[];
  onToolClick: (id: string) => void;
  focusedNodeId: string | null;
}) {
  return (
    <section className="relative flex flex-col min-w-0 min-h-0 bg-ink-850 hairline-r">
      <ChatHeader />
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {messages.map((m) => (
          <MessageRow
            key={m.id}
            msg={m}
            onToolClick={onToolClick}
            focusedNodeId={focusedNodeId}
          />
        ))}
      </div>
      <ChatComposer />
    </section>
  );
}

function ChatHeader() {
  return (
    <div className="h-10 hairline-b px-4 flex items-center gap-3 bg-ink-850/80 backdrop-blur">
      <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
        conversation
      </span>
      <div className="flex items-center gap-2 ml-auto">
        <span className="font-mono text-micro text-fog-700">8 msgs 3 tools linked</span>
        <span className="w-px h-3 bg-ink-600" />
        <button className="font-mono text-micro text-fog-500 hover:text-fog-200 transition">
          compact
        </button>
        <button className="font-mono text-micro text-fog-500 hover:text-fog-200 transition">
          raw
        </button>
      </div>
    </div>
  );
}

function MessageRow({
  msg,
  onToolClick,
  focusedNodeId,
}: {
  msg: ChatMessage;
  onToolClick: (id: string) => void;
  focusedNodeId: string | null;
}) {
  if (msg.role === 'thinking') return <ThinkingBlock msg={msg} />;
  if (msg.role === 'user') return <UserMessage msg={msg} />;
  return <AssistantMessage msg={msg} onToolClick={onToolClick} focusedNodeId={focusedNodeId} />;
}

function UserMessage({ msg }: { msg: ChatMessage }) {
  return (
    <div className="group animate-fade-up">
      <div className="flex items-center gap-2 mb-1.5">
        <div className="w-5 h-5 rounded grid place-items-center bg-ink-700 text-fog-300">
          <IconUser size={11} />
        </div>
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-500">you</span>
        <span className="font-mono text-micro text-fog-700">{msg.timestamp}</span>
      </div>
      <div className="pl-7 text-[13.5px] leading-relaxed text-fog-100">{msg.content}</div>
    </div>
  );
}

function ThinkingBlock({ msg }: { msg: ChatMessage }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="animate-fade-up">
      <button
        onClick={() => setOpen(!open)}
        className="group flex items-center gap-2 text-left"
      >
        <div className="w-5 h-5 rounded grid place-items-center bg-transparent border border-iris/30 text-iris">
          <IconThinking size={11} />
        </div>
        <span className="font-mono text-micro uppercase tracking-widest2 text-iris/80">
          thinking
        </span>
        <span className="font-mono text-micro text-fog-700">{msg.timestamp}</span>
        <span className="font-mono text-micro text-fog-700 group-hover:text-fog-500 transition">
          {open ? '[ collapse ]' : '[ expand ]'}
        </span>
      </button>
      <div
        className={clsx(
          'pl-7 mt-1.5 relative overflow-hidden transition-all',
          open ? 'max-h-96' : 'max-h-6'
        )}
      >
        <div className="absolute left-[9px] top-0 bottom-0 w-px bg-gradient-to-b from-iris/40 via-iris/10 to-transparent" />
        <p
          className={clsx(
            'font-display italic text-[14px] leading-relaxed text-fog-400',
            !open && 'truncate'
          )}
        >
          {msg.content}
        </p>
      </div>
    </div>
  );
}

function AssistantMessage({
  msg,
  onToolClick,
  focusedNodeId,
}: {
  msg: ChatMessage;
  onToolClick: (id: string) => void;
  focusedNodeId: string | null;
}) {
  return (
    <div className="group animate-fade-up">
      <div className="flex items-center gap-2 mb-1.5">
        <div className="w-5 h-5 rounded grid place-items-center bg-molten/10 text-molten">
          <IconSpark size={11} />
        </div>
        <span className="font-mono text-micro uppercase tracking-widest2 text-molten/90">
          opus
        </span>
        <span className="font-mono text-micro text-fog-700">{msg.timestamp}</span>
      </div>
      <div className="pl-7 text-[13.5px] leading-relaxed text-fog-200">{msg.content}</div>

      {msg.toolRefs && msg.toolRefs.length > 0 && (
        <div className="pl-7 mt-2.5 flex flex-wrap gap-1.5">
          {msg.toolRefs.map((ref) => {
            const Icon = toolIcon(ref.tool);
            const focused = focusedNodeId === ref.id;
            return (
              <button
                key={ref.id}
                onClick={() => onToolClick(ref.id)}
                className={clsx(
                  'group/ref flex items-center gap-1.5 h-6 pl-1.5 pr-2.5 rounded',
                  'bg-ink-800 hairline hover:border-ink-500 transition',
                  focused && 'border-molten/50 bg-molten/5'
                )}
              >
                <span
                  className={clsx(
                    'w-4 h-4 grid place-items-center rounded text-fog-500 group-hover/ref:text-fog-200 transition',
                    focused && 'text-molten'
                  )}
                >
                  <Icon size={11} />
                </span>
                <span className="font-mono text-micro uppercase tracking-wider text-fog-600">
                  {ref.tool}
                </span>
                <span className="font-mono text-2xs text-fog-300">{ref.label}</span>
                <span className="font-mono text-micro text-fog-700 ml-1"></span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ChatComposer() {
  const [val, setVal] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="hairline-t p-3 bg-ink-850">
      <div className="relative rounded-md bg-ink-800 hairline focus-within:border-molten/40 transition">
        <textarea
          ref={ref}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder="follow up - describe a change, paste an error, ask a question"
          rows={2}
          className="w-full bg-transparent resize-none px-3 py-2.5 text-[13px] text-fog-100 placeholder:text-fog-700 focus:outline-none"
        />
        <div className="flex items-center gap-2 px-3 pb-2 pt-0">
          <button className="font-mono text-micro uppercase tracking-wider text-fog-600 hover:text-fog-200 transition">
            + attach
          </button>
          <button className="font-mono text-micro uppercase tracking-wider text-fog-600 hover:text-fog-200 transition">
            /slash
          </button>
          <span className="ml-auto flex items-center gap-2 font-mono text-micro text-fog-700">
            <span>shift+enter newline</span>
            <span className="w-px h-3 bg-ink-600" />
            <span>send</span>
          </span>
        </div>
      </div>
    </div>
  );
}
