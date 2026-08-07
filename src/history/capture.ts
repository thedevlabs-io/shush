// ABOUTME: Records a snapshot when a protected file is saved, warning once if it cannot.
// ABOUTME: Silent failure would leave the user believing history is on when it is not.

import * as vscode from "vscode";
import type { HistoryStore } from "./store";

export class SnapshotRecorder {
  constructor(private readonly history: HistoryStore) {}

  /** Files we've already warned about, so a failing keychain nags once, not on every save. */
  private readonly warned = new Set<string>();

  /**
   * Snapshot a save. Failures are surfaced rather than swallowed: silently not
   * recording, while the user believes history is on, is the worst outcome here.
   */
  async capture(doc: vscode.TextDocument): Promise<void> {
    const key = doc.uri.toString();
    try {
      const result = await this.history.capture(
        key,
        vscode.workspace.asRelativePath(doc.uri, true),
        doc.getText()
      );
      if (result === "too-large" && !this.warned.has(key)) {
        this.warned.add(key);
        void vscode.window.showWarningMessage(
          "Shush: this file is too large to snapshot, so no version history is being kept for it."
        );
      }
    } catch (err) {
      console.error("[Shush] failed to store a version snapshot", err);
      if (!this.warned.has(key)) {
        this.warned.add(key);
        void vscode.window.showWarningMessage(
          "Shush: couldn't write to the OS credential store, so version history is not being saved."
        );
      }
    }
  }
}
