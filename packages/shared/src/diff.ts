import fastDiff from "fast-diff";

// ─── Types ──────────────────────────────────────────────────

/** Minimal interface matching Y.Text — avoids yjs dependency in shared. */
export interface YTextLike {
  insert(index: number, text: string): void;
  delete(index: number, length: number): void;
  toString(): string;
}

/** A single diff operation: insert text or delete a range. */
export type DiffOp =
  | { type: "insert"; index: number; text: string }
  | { type: "delete"; index: number; length: number };

// ─── Core ───────────────────────────────────────────────────

/**
 * Compute character-level diff between two strings.
 *
 * Uses fast-diff to produce minimal insert/delete operations.
 * Operations are ordered by ascending index (natural document order).
 */
export function computeDiff(oldText: string, newText: string): DiffOp[] {
  if (oldText === newText) return [];

  const rawDiffs = fastDiff(oldText, newText);
  const ops: DiffOp[] = [];
  let cursor = 0;

  for (const [kind, text] of rawDiffs) {
    switch (kind) {
      case fastDiff.EQUAL:
        cursor += text.length;
        break;
      case fastDiff.DELETE:
        ops.push({ type: "delete", index: cursor, length: text.length });
        // cursor stays — deleted text no longer occupies space,
        // but fast-diff produces diffs against the OLD string,
        // so we advance past the deleted region.
        cursor += text.length;
        break;
      case fastDiff.INSERT:
        ops.push({ type: "insert", index: cursor, text });
        // Do NOT advance cursor — insert does not consume old text.
        break;
    }
  }

  return ops;
}

// ─── Y.Text Application ────────────────────────────────────

/**
 * Apply DiffOps to a Y.Text-like target.
 *
 * Operations are applied in **reverse index order** so earlier indices
 * remain valid after later mutations.
 */
export function applyDiffToYText(ytext: YTextLike, ops: DiffOp[]): void {
  if (ops.length === 0) return;

  // Sort descending by index so mutations don't shift later positions.
  const sorted = [...ops].sort((a, b) => b.index - a.index);

  for (const op of sorted) {
    if (op.type === "delete") {
      ytext.delete(op.index, op.length);
    } else {
      ytext.insert(op.index, op.text);
    }
  }
}

// ─── Convenience ────────────────────────────────────────────

/**
 * Compute diff between old/new text and apply it to a Y.Text instance.
 *
 * Returns the operations for logging or metrics.
 */
export function computeAndApply(
  ytext: YTextLike,
  oldText: string,
  newText: string,
): DiffOp[] {
  const ops = computeDiff(oldText, newText);
  applyDiffToYText(ytext, ops);
  return ops;
}
