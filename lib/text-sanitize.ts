// Text sanitiser for model-emitted strings. Strips tool-call protocol
// markers that some models leak into their text output.
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
//   - OpenAI-style:            `<|endofcompletion|>`
//
// Two classes of leaked markup:
//
//   A. Protocol tokens — `<|...|>` angle-pipe brackets emitted by the
//      tokenizer but not consumed by the chat template. Rare in good
//      models, common in quantised/local models.
//
//   B. Pseudo-XML tool calls — the model fabricates tool invocations
//      as plain text. Patterns seen in production:
//        - `<tool>Bash\n<command>...</command>\n<description>...</description>\n</tool>`
//        - `<read path='...'></read>`
//        - `<grep ... />`
//        - `<tool|>`
//        - `<find-files ... />`
//
//      These are NOT real protocol tokens — they're the model's attempt
//      to call tools via text. We strip them so the chat bubble shows
//      either the descriptive text that surrounds them, or a one-line
//      summary ("attempted tool call: Bash") in place of the raw markup.
//
// Apply at display boundaries — the UI text renderers (MarkdownBody,
// debate-rail judge text, retro lessons). Don't apply on the data
// path: planner parsers / heat extractors / diff readers want the
// raw text.

// --- Class A: protocol tokens ------------------------------------------------
const PROTOCOL_TOKEN_RE =
  /<\|[A-Za-z0-9_]{1,40}\|>|<\/?antml:[a-zA-Z_]{1,40}>|<\|endoftext\|>|<\|endofcompletion\|>/g;

// --- Class B: pseudo-XML tool calls ------------------------------------------
// Matches: <tool>Name\n<command>...</command>\n<description>...</description>\n</tool>
//          <tool|>
//          <read path='...'></read>
//          <grep ... />
//          <find-files ... />
//          <list path='...' />
const PSEUDO_XML_TOOL_RE =
  /<tool>([\s\S]*?)<\/tool>|<\/?tool\|?>|<(?:read|write|edit|bash|glob|grep|codesearch|webfetch|websearch|todowrite|task|question|skill|apply_patch|find-files|list)\b[^>]*?\/?>|<\/(?:read|write|edit|bash|glob|grep|codesearch|webfetch|websearch|todowrite|task|question|skill|apply_patch|find-files|list)>/g;

export function stripProtocolTokens(text: string): string {
  if (!text) return text;
  // Class A: strip protocol tokens
  let result = text;
  PROTOCOL_TOKEN_RE.lastIndex = 0;
  if (PROTOCOL_TOKEN_RE.test(result)) {
    PROTOCOL_TOKEN_RE.lastIndex = 0;
    result = result.replace(PROTOCOL_TOKEN_RE, '');
  }
  // Class B: strip pseudo-XML tool calls
  PSEUDO_XML_TOOL_RE.lastIndex = 0;
  if (PSEUDO_XML_TOOL_RE.test(result)) {
    PSEUDO_XML_TOOL_RE.lastIndex = 0;
    result = result.replace(PSEUDO_XML_TOOL_RE, '');
  }
  // Collapse runs of whitespace left behind by the removals.
  // Also trim leading/trailing blank lines so adjacent content joins cleanly.
  result = result.replace(/\n{3,}/g, '\n\n').replace(/^[ \t]*\n+/, '').replace(/\n+[ \t]*$/, '');
  return result;
}
