// Robust JSON extraction from LLM output.
//
// LLMs often wrap JSON in markdown code fences (```json ... ```) or
// surround it with prose. This module provides a single function
// `extractJSON` that tries, in order:
//
//   1. Direct JSON.parse (the text is already valid JSON)
//   2. Strip ```json ... ``` fences, then parse
//   3. Strip ``` ... ``` fences, then parse
//   4. Find the outermost {…} or […] and parse that substring
//   5. Find the outermost {…} or […] with trailing-comma repair
//
// If none succeed, returns null. Callers can choose whether to
// fall back to a default or surface an error.

// Trailing commas are the most common JSON syntax error from LLMs.
// This regex strips commas that precede ] or } (with optional whitespace).
const TRAILING_COMMA_RE = /,\s*([}\]])/g;

function stripTrailingCommas(text: string): string {
  return text.replace(TRAILING_COMMA_RE, '$1');
}

// Extract the first balanced {…} or […] from text. Handles nested
// brackets and respects strings (so a } inside a string doesn't close
// the object).
function findBalancedBrackets(text: string): string | null {
  const opens = ['{', '['];
  const closes = ['}', ']'];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const openIdx = opens.indexOf(ch);
    if (openIdx === -1) continue;

    const closeChar = closes[openIdx];
    let depth = 0;
    let inStr = false;
    let escaped = false;

    for (let j = i; j < text.length; j++) {
      const c = text[j];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        continue;
      }
      if (c === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;

      if (c === ch) depth++;
      if (c === closeChar) depth--;

      if (depth === 0) {
        return text.slice(i, j + 1);
      }
    }
  }

  return null;
}

const JSON_FENCE_RE = /```json\s*\n([\s\S]*?)\n\s*```/i;
const CODE_FENCE_RE = /```\s*\n([\s\S]*?)\n\s*```/;

export function extractJSON<T = unknown>(text: string): T | null {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // 1. Direct parse
  try {
    return JSON.parse(trimmed) as T;
  } catch {}

  // 2. Strip ```json fences
  const jsonFenced = JSON_FENCE_RE.exec(trimmed);
  if (jsonFenced) {
    try {
      return JSON.parse(jsonFenced[1]) as T;
    } catch {}
    try {
      return JSON.parse(stripTrailingCommas(jsonFenced[1])) as T;
    } catch {}
  }

  // 3. Strip generic ``` fences
  const codeFenced = CODE_FENCE_RE.exec(trimmed);
  if (codeFenced) {
    try {
      return JSON.parse(codeFenced[1]) as T;
    } catch {}
    try {
      return JSON.parse(stripTrailingCommas(codeFenced[1])) as T;
    } catch {}
  }

  // 4. Find balanced brackets
  const bracketed = findBalancedBrackets(trimmed);
  if (bracketed) {
    try {
      return JSON.parse(bracketed) as T;
    } catch {}
    try {
      return JSON.parse(stripTrailingCommas(bracketed)) as T;
    } catch {}
  }

  return null;
}