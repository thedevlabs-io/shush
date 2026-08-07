// ABOUTME: Pure, dependency-free helpers shared by the editor and the history store —
// ABOUTME: key validation, value sanitising, snapshot ids and pruning. No vscode import, so unit-testable.

import { createHash } from "node:crypto";

/** Snapshot metadata sent to the webview — never carries the secret content. */
export interface SnapshotMeta {
  /** Epoch milliseconds the snapshot was taken. */
  at: number;
  bytes: number;
}

export interface Snapshot extends SnapshotMeta {
  content: string;
}

/**
 * Env keys we accept when adding a row. Deliberately stricter than what the
 * parser tolerates: anything outside this set risks writing a line the parser
 * would not read back, silently orphaning the value.
 */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function isValidEnvKey(key: string): boolean {
  return ENV_KEY.test(key);
}

/**
 * A value is written verbatim into a single env line, so an embedded newline
 * would inject arbitrary extra lines into the file (a `KEY=v\nADMIN=1` edit
 * silently adds a variable). Collapse them instead of rejecting the edit.
 */
export function sanitizeEnvValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

/** Strip the optional `export ` prefix so `export API_KEY` and `API_KEY` compare equal. */
export function envKeyName(label: string): string {
  return label.replace(/^export\s+/, "").trim();
}

/**
 * Path segments that don't reach a real own-property. Assigning through them is
 * silently dropped by the engine, so an edit would vanish with no feedback.
 */
export function isUnsafeJsonSegment(segment: string | number): boolean {
  return segment === "__proto__" || segment === "constructor" || segment === "prototype";
}

/** Stable, non-reversible id for a file's history bucket in SecretStorage. */
export function fileId(uriString: string): string {
  return createHash("sha256").update(uriString).digest("hex").slice(0, 32);
}

/** Newest first, capped to `max`. Snapshots are stored and returned in this order. */
export function prune(snapshots: Snapshot[], max: number): Snapshot[] {
  return [...snapshots].sort((a, b) => b.at - a.at).slice(0, Math.max(1, max));
}

export function toMeta(snapshots: Snapshot[]): SnapshotMeta[] {
  return snapshots.map((s) => ({ at: s.at, bytes: s.bytes }));
}
