import 'server-only';

export type ValidationResult =
  | { ok: true }
  | {
      ok: false;
      duplicates: number;
      vagueCriteria: number;
      message: string;
    };

export function validatePlannerOutput(
  proposed: Array<{ content: string; isCriterion: boolean }>,
  existingContent: string[],
): ValidationResult {
  const duplicates: string[] = [];
  const vagueCriteria: string[] = [];

  for (const item of proposed) {
    const isDuplicate = existingContent.some((existing) => {
      const overlap = tokenOverlap(item.content, existing);
      return overlap >= 0.6;
    });
    if (isDuplicate) duplicates.push(item.content.slice(0, 40));

    if (item.isCriterion && isVague(item.content)) {
      vagueCriteria.push(item.content.slice(0, 40));
    }
  }

  if (duplicates.length > 0 || vagueCriteria.length > 0) {
    const lines: string[] = [];
    if (duplicates.length > 0)
      lines.push(
        `${duplicates.length} duplicate item(s): ${duplicates.slice(0, 3).join('; ')}`,
      );
    if (vagueCriteria.length > 0)
      lines.push(
        `${vagueCriteria.length} vague criterion/a: ${vagueCriteria.slice(0, 3).join('; ')}`,
      );
    return {
      ok: false,
      duplicates: duplicates.length,
      vagueCriteria: vagueCriteria.length,
      message: lines.join('. '),
    };
  }

  return { ok: true };
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / Math.min(ta.size, tb.size);
}

const MIN_CRITERION_CHARS = 20;
const VAGUE_CRITERION_RE =
  /^\s*(make|improve|polish|clean\s*up|fix|update|tighten|tidy|refine)\s+\w+\s+(better|good|nice|clean|right|proper|solid|tidy)\s*\.?$/i;

function isVague(content: string): boolean {
  if (content.length < MIN_CRITERION_CHARS) return true;
  return VAGUE_CRITERION_RE.test(content.trim());
}
