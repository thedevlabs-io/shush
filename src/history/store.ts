// ABOUTME: Opt-in local version history for protected secret files. Snapshots are held in
// ABOUTME: VS Code SecretStorage (OS keychain) — never written to disk or into the workspace.

import { fileId, prune, toMeta, type Snapshot, type SnapshotMeta } from "../core/model";

export const ENABLED_KEY = "shush.history.enabled";
export const MAX_VERSIONS_KEY = "shush.history.maxVersions";

const ENTRY_PREFIX = "shush.history.file.";
/** Index of file-id → last known label, so "clear history" can purge every bucket. */
const INDEX_KEY = "shush.history.index";

/**
 * Snapshots go into the OS keychain, which is not a bulk store — a large file
 * would bloat it and, on some platforms, fail to write at all. Skip anything
 * bigger; a 256 KB .env is not a real secrets file.
 */
export const MAX_SNAPSHOT_BYTES = 256 * 1024;

/** The slice of `vscode.SecretStorage` we use — narrowed so tests can fake it. */
export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export interface HistorySettings {
  enabled: boolean;
  maxVersions: number;
}

export type CaptureResult = "stored" | "disabled" | "unchanged" | "too-large";

/**
 * Encrypted, opt-in snapshot store.
 *
 * Reads tolerate a missing or corrupt bucket by returning empty — history is a
 * convenience, and a keychain hiccup must never block opening a file. Writes are
 * *not* forgiving: they reject so the caller can tell the user history is dead
 * rather than let them believe they are covered.
 */
export class HistoryStore {
  /**
   * Every index mutation runs through this chain. Two files saving in the same
   * tick would otherwise both read the index, both write it, and the second
   * would drop the first — orphaning a bucket of secrets that `clearAll` can no
   * longer find or delete.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly secrets: SecretStore,
    private readonly settings: () => HistorySettings
  ) {}

  /** Read through on every access: the setting is a security control, so off must be immediate. */
  get enabled(): boolean {
    return this.settings().enabled;
  }

  private get maxVersions(): number {
    const n = this.settings().maxVersions;
    return Math.min(Math.max(Math.floor(n) || 1, 1), 50);
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    // Keep the chain alive even if this link rejects, or later writes never run.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async readBucket(id: string): Promise<Snapshot[]> {
    try {
      const raw = await this.secrets.get(ENTRY_PREFIX + id);
      if (!raw) {
        return [];
      }
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter((s: unknown): s is Snapshot => {
        const snapshot = s as Partial<Snapshot> | null;
        return typeof snapshot?.at === "number" && typeof snapshot?.content === "string";
      });
    } catch {
      return [];
    }
  }

  /**
   * Read a bucket already trimmed to the current retention limit, persisting the
   * trim. Lowering `maxVersions` must actually drop the excess copies, not wait
   * for a save that may never come.
   */
  private async readBucketPruned(id: string): Promise<Snapshot[]> {
    const snapshots = await this.readBucket(id);
    const kept = prune(snapshots, this.maxVersions);
    if (kept.length !== snapshots.length) {
      await this.secrets.store(ENTRY_PREFIX + id, JSON.stringify(kept));
    }
    return kept;
  }

  private async readIndex(): Promise<Record<string, string>> {
    try {
      const raw = await this.secrets.get(INDEX_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  }

  /**
   * Record `content` as the newest version of `uriString`. The index entry is
   * written *before* the bucket, so a failure in between orphans nothing —
   * an index entry with no bucket is harmless, a bucket with no index entry is
   * secrets `clearAll` can never reach.
   */
  async capture(uriString: string, label: string, content: string): Promise<CaptureResult> {
    if (!this.enabled) {
      return "disabled";
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_SNAPSHOT_BYTES) {
      return "too-large";
    }
    return this.serialize(async () => {
      const id = fileId(uriString);
      const existing = await this.readBucket(id);
      if (existing[0]?.content === content) {
        return "unchanged"; // saved without changing anything we keep
      }
      const index = await this.readIndex();
      if (index[id] !== label) {
        index[id] = label;
        await this.secrets.store(INDEX_KEY, JSON.stringify(index));
      }
      const next = prune([{ at: Date.now(), bytes, content }, ...existing], this.maxVersions);
      await this.secrets.store(ENTRY_PREFIX + id, JSON.stringify(next));
      return "stored";
    });
  }

  async list(uriString: string): Promise<SnapshotMeta[]> {
    return toMeta(await this.readBucketPruned(fileId(uriString)));
  }

  async contentAt(uriString: string, at: number): Promise<string | undefined> {
    return (await this.readBucket(fileId(uriString))).find((s) => s.at === at)?.content;
  }

  async clearFile(uriString: string): Promise<void> {
    return this.serialize(async () => {
      const id = fileId(uriString);
      await this.secrets.delete(ENTRY_PREFIX + id);
      const index = await this.readIndex();
      delete index[id];
      await this.secrets.store(INDEX_KEY, JSON.stringify(index));
    });
  }

  /**
   * Purge every snapshot this extension holds. `alsoKnown` lets the caller name
   * files it knows about (currently-open protected documents) so a bucket whose
   * index entry was somehow lost still gets deleted.
   */
  async clearAll(alsoKnown: string[] = []): Promise<number> {
    return this.serialize(async () => {
      const index = await this.readIndex();
      const ids = new Set([...Object.keys(index), ...alsoKnown.map(fileId)]);
      for (const id of ids) {
        await this.secrets.delete(ENTRY_PREFIX + id);
      }
      await this.secrets.delete(INDEX_KEY);
      return ids.size;
    });
  }
}
