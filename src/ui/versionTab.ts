// ABOUTME: Opening a stored version, or a diff of two, in its own tab; and restoring one.
// ABOUTME: Split from the editor so version handling reads as one thing.

import * as vscode from "vscode";
import type { HistoryStore } from "../history/store";
import { diffEntries, type DiffRow } from "../core/diff";
import { detectFormat, fullRange, parseText, stamp, toEntries } from "../core/secretsDocument";
import { HistoryPanel } from "./historyPanel";
import type { SnapshotRecorder } from "../history/capture";

export interface VersionContext {
  history: HistoryStore;
  recorder: SnapshotRecorder;
}

/**
 * Render the history tab for a chosen pair. `before`/`after` are option values:
 * "none" (show one version only), "current" (the file as it stands), or a
 * snapshot timestamp. Repicking in the tab's dropdowns comes back through here.
 */
export async function openHistoryTab(
  ctx: VersionContext,
  document: vscode.TextDocument,
  before: string,
  after: string
): Promise<void> {
  const key = document.uri.toString();
  const format = detectFormat(document);
  const versions = await ctx.history.list(key);

  const sideContent = async (value: string): Promise<string | undefined> =>
    value === "current" ? document.getText() : ctx.history.contentAt(key, Number(value));

  const label = (value: string): string =>
    value === "current" ? "current file" : stamp(Number(value));

  const newerText = await sideContent(after);
  if (newerText === undefined) {
    void vscode.window.showWarningMessage("Shush: that version is no longer stored.");
    return;
  }
  const newer = toEntries(parseText(newerText, format).rows, format);

  let rows: DiffRow[];
  let beforeLabel = "";
  const single = before === "none";
  if (single) {
    rows = newer.map((e) => ({ key: e.key, kind: "unchanged" as const, after: e.value }));
  } else {
    const olderText = await sideContent(before);
    if (olderText === undefined) {
      void vscode.window.showWarningMessage("Shush: that version is no longer stored.");
      return;
    }
    beforeLabel = label(before);
    rows = diffEntries(toEntries(parseText(olderText, format).rows, format), newer);
  }

  HistoryPanel.show(
    key,
    {
      fileName: document.uri.path.split("/").pop() ?? "secrets",
      beforeLabel,
      afterLabel: label(after),
      single,
      rows,
      options: [
        { value: "none", label: "— nothing (show one version)" },
        { value: "current", label: "current file" },
        ...versions.map((v: { at: number }) => ({ value: String(v.at), label: stamp(v.at) })),
      ],
      before,
      after,
    },
    {
      onSelect: (nextBefore, nextAfter) =>
        void openHistoryTab(ctx, document, nextBefore, nextAfter),
      onRestore: (target) => void restoreVersion(ctx, document, target),
    }
  );
}

/** Show what would change, then confirm. Seeing the diff first is the point. */
export async function restoreVersion(
  ctx: VersionContext,
  document: vscode.TextDocument,
  at: number
): Promise<void> {
  const content = await ctx.history.contentAt(document.uri.toString(), at);
  if (content === undefined) {
    void vscode.window.showWarningMessage("Shush: that version is no longer stored.");
    return;
  }
  await openHistoryTab(ctx, document, String(at), "current");

  const confirm = await vscode.window.showWarningMessage(
    `Replace ${document.uri.path.split("/").pop()} with the version from ${new Date(at).toLocaleString()}?`,
    {
      modal: true,
      detail:
        "The changes are shown in the history tab. The current contents are snapshotted first, so this is reversible.",
    },
    "Restore"
  );
  if (confirm !== "Restore") {
    return;
  }
  await ctx.recorder.capture(document);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, fullRange(document), content);
  await vscode.workspace.applyEdit(edit);
  await openHistoryTab(ctx, document, String(at), "current");
}
