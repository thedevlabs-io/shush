// ABOUTME: Key-level comparison between two versions of a secrets file. Pure and vscode-free.
// ABOUTME: Compares by key rather than by line — for a .env, "which keys changed" is the real question.

export type ChangeKind = "added" | "removed" | "changed" | "unchanged";

export interface Entry {
  key: string;
  value: string;
}

export interface DiffRow {
  key: string;
  kind: ChangeKind;
  /** Absent for an added key. */
  before?: string;
  /** Absent for a removed key. */
  after?: string;
}

export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
}

/**
 * Compare two versions by key. Rows follow the newer version's order so the
 * result reads like the file; keys that only exist in the older version are
 * appended, in their original order, since they have no place in the new one.
 */
export function diffEntries(before: Entry[], after: Entry[]): DiffRow[] {
  const beforeMap = new Map(before.map((e) => [e.key, e.value]));
  const afterMap = new Map(after.map((e) => [e.key, e.value]));

  const rows: DiffRow[] = after.map((e) => {
    if (!beforeMap.has(e.key)) {
      return { key: e.key, kind: "added", after: e.value };
    }
    const prev = beforeMap.get(e.key) ?? "";
    return prev === e.value
      ? { key: e.key, kind: "unchanged", before: prev, after: e.value }
      : { key: e.key, kind: "changed", before: prev, after: e.value };
  });

  for (const e of before) {
    if (!afterMap.has(e.key)) {
      rows.push({ key: e.key, kind: "removed", before: e.value });
    }
  }
  return rows;
}

export function summarize(rows: DiffRow[]): DiffSummary {
  const summary: DiffSummary = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const r of rows) {
    summary[r.kind]++;
  }
  return summary;
}

/** One-line description of a diff, for the panel header. */
export function describe(summary: DiffSummary): string {
  const parts: string[] = [];
  if (summary.added) {
    parts.push(`${summary.added} added`);
  }
  if (summary.removed) {
    parts.push(`${summary.removed} removed`);
  }
  if (summary.changed) {
    parts.push(`${summary.changed} changed`);
  }
  return parts.length ? parts.join(", ") : "No differences";
}
