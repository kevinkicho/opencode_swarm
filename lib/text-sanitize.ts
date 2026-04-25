// Text sanitiser for model-emitted strings. Strips tool-call protocol
// markers that some local models leak into their text output.
//
// Why this exists: ollama-swarm sibling app (2026-04-25 #114) found
// `<|tool_call_begin|>` strings appearing in user-visible assistant
// text. Same risk applies here for any model that emits these tokens
// in its content stream rather than its tool-call channel. Common
// model formats:
//
//   - qwen / open-source LLM: `<|tool_call_begin|>`, `<|tool_call_end|>`,
//                              `<|im_start|>`, `<|im_end|>`,
//                              `<|fim_prefix|>`, `<|fim_middle|>`,
//                              `<|fim_suffix|>`
//   - Anthropic-style:         `<...>` / `</...>`
//   - OpenAI-style:            `<|endoftext|>`, `<|endofcompletion|>`
//
// Apply at display boundaries — the UI text renderers (MarkdownBody,
// debate-rail judge text, retro lessons). Don't apply on the data
// path: planner parsers / heat extractors / diff readers want the
// raw text. The leaked tokens only matter when a human reads the
// output.
//
// Conservative: leaves any text that doesn't look like a protocol
// marker untouched. The regex requires `<|...|>` with content between
// the pipes that's max 40 chars and contains no `|` or whitespace —
// real markdown-pipe-table cells won't match because they're typically
// surrounded by spaces and have longer content.

const PROTOCOL_TOKEN_RE =
  /<\|[A-Za-z0-9_]{1,40}\|>|<\/?antml:[a-zA-Z_]{1,40}>/g;

export function stripProtocolTokens(text: string): string {
  if (!text) return text;
  if (!PROTOCOL_TOKEN_RE.test(text)) return text;
  // Reset regex state — global regexes carry lastIndex across exec/test calls.
  PROTOCOL_TOKEN_RE.lastIndex = 0;
  return text.replace(PROTOCOL_TOKEN_RE, '');
}
