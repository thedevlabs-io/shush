// ABOUTME: Pure row filtering behind the editor's find bar — matches a query against keys, values, or both.
// ABOUTME: Self-contained on purpose: the webview embeds this function's source, so it must not reference anything outside itself.

export type SearchScope = "keys" | "values" | "both";

export interface SearchRow {
  depth: number;
  label: string;
  container?: boolean;
  value?: string;
}

export interface SearchResult {
  /** One flag per input row, in order: true when the row stays visible. */
  keep: boolean[];
  /** Rows that matched the query themselves, ignoring rows kept only for context. */
  matches: number;
}

/**
 * Decide which rows survive a query. A matching leaf keeps its ancestor
 * containers so a JSON hit is still readable in its tree; a matching container
 * keeps everything beneath it.
 *
 * Matching a value never reveals it — the caller renders hits through the same
 * masked field as everything else.
 *
 * The ancestor walk is O(n) per kept row. Fine for the file sizes this editor
 * opens; revisit if a JSON config ever runs to thousands of leaves.
 */
export function filterRows(
  rows: SearchRow[],
  query: string,
  scope: SearchScope,
  caseSensitive: boolean
): SearchResult {
  const trimmed = query.trim();
  const keep = rows.map(() => trimmed === "");
  if (trimmed === "") {
    return { keep, matches: 0 };
  }

  const needle = caseSensitive ? trimmed : trimmed.toLowerCase();
  const hasNeedle = (text: string | undefined): boolean => {
    if (typeof text !== "string") {
      return false;
    }
    return (caseSensitive ? text : text.toLowerCase()).indexOf(needle) !== -1;
  };

  let matches = 0;
  /** Depth of the matched container we're inside, or -1 when we aren't. */
  let underDepth = -1;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (underDepth >= 0 && row.depth <= underDepth) {
      underDepth = -1;
    }
    const labelHit = scope !== "values" && hasNeedle(row.label);
    const valueHit = scope !== "keys" && !row.container && hasNeedle(row.value);
    const hit = labelHit || valueHit;
    if (hit) {
      matches++;
    }
    if (!hit && underDepth < 0) {
      continue;
    }
    keep[i] = true;
    let depth = row.depth;
    for (let j = i - 1; j >= 0 && depth > 0; j--) {
      if (rows[j].container && rows[j].depth < depth) {
        keep[j] = true;
        depth = rows[j].depth;
      }
    }
    // Only the outermost matched container is tracked: a nested match must not
    // overwrite it, or leaving the inner one would drop the outer one's siblings.
    if (hit && row.container && underDepth < 0) {
      underDepth = row.depth;
    }
  }

  return { keep, matches };
}
