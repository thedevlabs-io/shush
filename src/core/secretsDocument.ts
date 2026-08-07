// ABOUTME: Parsing and editing model for redacted files — env lines and the JSON tree.
// ABOUTME: vscode-free except for document types, so the parsing rules are testable.

import * as vscode from "vscode";
import { envKeyName } from "./model";
import type { Entry } from "./diff";

export type Format = "env" | "json";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonContainer = JsonValue[] | { [key: string]: JsonValue };

export function isContainer(value: JsonValue): value is JsonContainer {
  return value !== null && typeof value === "object";
}

export function childAt(node: JsonContainer, token: string | number): JsonValue | undefined {
  return Array.isArray(node)
    ? node[Number(token)]
    : (node as Record<string, JsonValue>)[String(token)];
}

export function setChild(node: JsonContainer, token: string | number, value: JsonValue): void {
  if (Array.isArray(node)) {
    node[Number(token)] = value;
  } else {
    (node as Record<string, JsonValue>)[String(token)] = value;
  }
}

/** Parse a document's JSON, or undefined when it isn't valid. */
export function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

export function leafText(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** A row shown in the webview — either a leaf value or a container header. */
export interface Row {
  /** Nesting depth, used to indent the tree. */
  depth: number;
  /** The label shown for this row (own key/index, not the full path). */
  label: string;
  /** True for object/array headers that group the rows beneath them. */
  container?: boolean;
  /** Stable id used to route edits back: "L<line>" for env, a JSON path for json. */
  id?: string;
  /** Present on leaf rows only. */
  value?: string;
}

export interface Parsed {
  format: Format;
  rows: Row[];
  /** Set when a JSON file could not be parsed; contents are shown as one masked block. */
  note?: string;
}

export function detectFormat(document: vscode.TextDocument): Format {
  if (document.languageId === "json" || document.languageId === "jsonc") {
    return "json";
  }
  if (document.uri.path.toLowerCase().endsWith(".json")) {
    return "json";
  }
  return "env";
}

// ---- env parsing ---------------------------------------------------------

export interface EnvLine {
  line: number;
  key: string;
  sep: string;
  value: string;
}

export function parseEnvLine(text: string, line: number): EnvLine | null {
  if (/^\s*(#.*)?$/.test(text)) {
    return null; // blank or comment
  }
  const m = /^(\s*(?:export\s+)?[\w.-]+)(\s*=\s*)(.*)$/.exec(text);
  if (!m) {
    return null;
  }
  return { line, key: m[1], sep: m[2], value: m[3] };
}

// ---- json parsing --------------------------------------------------------

/**
 * Walk a JSON value into an indented row tree. Containers become header rows;
 * leaves keep the full dotted/bracketed `id` (for edit routing) but display only
 * their own key/index at the right depth. `label === null` marks the root, which
 * emits no header of its own.
 */
export function buildRows(
  value: JsonValue,
  label: string | null,
  depth: number,
  id: string,
  out: Row[]
): void {
  if (isContainer(value)) {
    if (label !== null) {
      out.push({ depth, label, container: true });
    }
    const childDepth = label === null ? depth : depth + 1;
    if (Array.isArray(value)) {
      value.forEach((v, i) =>
        buildRows(v, `[${i}]`, childDepth, id ? `${id}[${i}]` : `[${i}]`, out)
      );
    } else {
      for (const [k, v] of Object.entries(value)) {
        buildRows(v, k, childDepth, id ? `${id}.${k}` : k, out);
      }
    }
    return;
  }
  out.push({
    depth,
    label: label ?? "",
    id,
    value: leafText(value),
  });
}

/** Tokenize a flattened path ("a.b[0].c") into keys/indices. */
export function pathTokens(path: string): (string | number)[] {
  const tokens: (string | number)[] = [];
  for (const part of path.split(".")) {
    const m = /^([^[\]]*)((\[\d+\])*)$/.exec(part);
    if (!m) {
      tokens.push(part);
      continue;
    }
    if (m[1]) {
      tokens.push(m[1]);
    }
    const idx = m[2].match(/\d+/g);
    if (idx) {
      idx.forEach((n) => tokens.push(Number(n)));
    }
  }
  return tokens;
}

/** Coerce a user-entered string back to the type of the value it replaces. */
export function coerce(previous: JsonValue | undefined, next: string): JsonValue {
  if (typeof previous === "number" && next.trim() !== "" && !isNaN(Number(next))) {
    return Number(next);
  }
  if (typeof previous === "boolean" && (next === "true" || next === "false")) {
    return next === "true";
  }
  if (previous === null && next === "null") {
    return null;
  }
  return next;
}

export function fullRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length)
  );
}

export function detectIndent(text: string): number | string {
  const m = /^(\t+|[ ]+)\S/m.exec(text);
  if (m) {
    return m[1][0] === "\t" ? "\t" : m[1].length;
  }
  return 2;
}

/**
 * Parse raw file text into display rows. Takes text rather than a document so
 * history snapshots render through exactly the same masking path as the file.
 */
export function parseText(text: string, format: Format): Parsed {
  if (format === "json") {
    const root = parseJson(text);
    if (root === undefined) {
      return {
        format,
        rows: [{ depth: 0, label: "(entire file)", id: "__raw__", value: text }],
        note: "This JSON couldn't be parsed, so the whole file is masked.",
      };
    }
    const rows: Row[] = [];
    buildRows(root, null, 0, "", rows);
    return { format, rows };
  }
  const rows: Row[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const parsed = parseEnvLine(line, i);
    if (parsed) {
      rows.push({ depth: 0, label: parsed.key.trim(), id: `L${parsed.line}`, value: parsed.value });
    }
  });
  return { format, rows };
}

/**
 * Flatten parsed rows into comparable key/value pairs. Env keys drop any
 * `export ` prefix; JSON leaves are keyed by their full path so a value that
 * moves between branches reads as a removal plus an addition, not a silent edit.
 */
export function toEntries(rows: Row[], format: Format): Entry[] {
  const entries: Entry[] = [];
  for (const row of rows) {
    if (row.container || row.value === undefined || row.id === "__raw__") {
      continue;
    }
    entries.push({
      key: format === "env" ? envKeyName(row.label) : row.id ?? row.label,
      value: row.value,
    });
  }
  return entries;
}

/** Messages the webview sends. Values are read defensively — this crosses a boundary. */
export interface WebviewMessage {
  type: string;
  id?: unknown;
  value?: unknown;
  at?: unknown;
}

export function asMessage(raw: unknown): WebviewMessage | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }
  const msg = raw as Partial<WebviewMessage>;
  return typeof msg.type === "string" ? (msg as WebviewMessage) : undefined;
}

/** Compact timestamp for tab titles and column headers. */
export function stamp(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
