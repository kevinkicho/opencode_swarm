// Parse-failure logger — durable record when an LLM verdict parser returns
// 'unclear'. These events are operator-visible findings on the board so the
// user can see which pattern the model produced that no parser recognized.
// Over time, these findings surface the most common parse-failure shapes and
// guide regex improvements.
//
// Call this from every orchestrator that receives an 'unclear' verdict from
// an LLM. It's fire-and-forget: insert errors are logged but never re-thrown,
// since the caller is already in a fail-open path.

import 'server-only';

import { mintItemId } from './blackboard/item-ids';
import { insertBoardItem } from './blackboard/store';

export interface ParseFailureOpts {
  // Which orchestrator pattern produced the unclear result.
  pattern: string;
  // Which parser role: 'critic', 'verifier', 'auditor', 'judge', 'synthesis-critic'.
  role: string;
  // The raw LLM reply text (truncated to avoid board bloat).
  rawReply: string;
  // The reason the parser returned 'unclear'.
  reason: string;
}

const RAW_REPLY_MAX_CHARS = 500;

export function recordParseFailure(
  swarmRunID: string,
  opts: ParseFailureOpts,
): void {
  try {
    const rawTrimmed =
      opts.rawReply.length > RAW_REPLY_MAX_CHARS
        ? `${opts.rawReply.slice(0, RAW_REPLY_MAX_CHARS)}…`
        : opts.rawReply;
    insertBoardItem(swarmRunID, {
      id: mintItemId(),
      kind: 'finding',
      content: `[${opts.pattern}] ${opts.role} parse-failure`,
      status: 'done',
      note: `${opts.reason}\n\nRaw reply:\n${rawTrimmed}`.slice(0, 2000),
    });
  } catch (err) {
    console.warn(
      `[parse-failure] ${swarmRunID}: recordParseFailure insert failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}