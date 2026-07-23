// ABOUTME: VS Code extension that gates protected files (.env and friends) behind a
// ABOUTME: confirmation modal so their contents never flash on screen unexpectedly.

import * as vscode from "vscode";

/**
 * URIs the user has explicitly chosen to reveal this session. A revealed file is
 * allowed to render until it is closed (and, if re-lock is on, is dropped again).
 */
const approved = new Set<string>();

/**
 * URIs we are in the middle of closing/re-opening. Tab events for these are
 * ignored to avoid a feedback loop between our close and the user's reveal.
 */
const inFlight = new Set<string>();

function config() {
  return vscode.workspace.getConfiguration("blockEnvExpose");
}

function isProtected(uri: vscode.Uri): boolean {
  if (uri.scheme !== "file") {
    return false;
  }
  const patterns = config().get<string[]>("patterns", []);
  const relative = vscode.workspace.asRelativePath(uri, false);
  // Match against both the workspace-relative path and the bare file name so a
  // pattern like "**/.env" still catches a lone ".env" outside any workspace.
  return patterns.some(
    (p) =>
      matchGlob(p, relative) ||
      matchGlob(p, uri.path) ||
      matchGlob(p, basename(uri.path))
  );
}

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

/**
 * Minimal glob matcher supporting the subset we need: `**`, `*`, and `?`.
 * `*` does not cross path separators; `**` does.
 */
function matchGlob(pattern: string, value: string): boolean {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // "**" (optionally followed by "/") matches across directories.
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  re += "$";
  return new RegExp(re).test(value);
}

function findTabForUri(uri: vscode.Uri): vscode.Tab | undefined {
  const key = uri.toString();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputText && input.uri.toString() === key) {
        return tab;
      }
    }
  }
  return undefined;
}

async function guard(uri: vscode.Uri): Promise<void> {
  if (!config().get<boolean>("enabled", true)) {
    return;
  }
  const key = uri.toString();
  if (approved.has(key) || inFlight.has(key) || !isProtected(uri)) {
    return;
  }

  inFlight.add(key);
  try {
    // Close the tab immediately so the contents never linger on screen.
    const tab = findTabForUri(uri);
    if (tab) {
      await vscode.window.tabGroups.close(tab, true);
    }

    const name = basename(uri.path);
    const choice = await vscode.window.showWarningMessage(
      `"${name}" may contain secrets. Reveal it?`,
      { modal: true, detail: "Its contents are hidden so they won't show on a screen share or call until you confirm." },
      "Reveal"
    );

    if (choice === "Reveal") {
      approved.add(key);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    }
  } finally {
    inFlight.delete(key);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // Guard anything already open when the extension activates.
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText) {
        void guard(tab.input.uri);
      }
    }
  }

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.opened) {
        if (tab.input instanceof vscode.TabInputText) {
          void guard(tab.input.uri);
        }
      }
      if (config().get<boolean>("relockOnClose", true)) {
        for (const tab of e.closed) {
          if (tab.input instanceof vscode.TabInputText) {
            const key = tab.input.uri.toString();
            if (!inFlight.has(key)) {
              approved.delete(key);
            }
          }
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blockEnvExpose.lockAll", () => {
      approved.clear();
      // Close any currently-open protected files so they re-prompt.
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.input instanceof vscode.TabInputText && isProtected(tab.input.uri)) {
            void guard(tab.input.uri);
          }
        }
      }
      void vscode.window.showInformationMessage("Block .env: all protected files re-locked.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blockEnvExpose.revealActive", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      approved.add(editor.document.uri.toString());
      void vscode.window.showInformationMessage("Block .env: file revealed.");
    })
  );
}

export function deactivate(): void {
  approved.clear();
  inFlight.clear();
}
