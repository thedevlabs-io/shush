// ABOUTME: Entry point for Shush — registers the redacting custom editor, loads extra
// ABOUTME: file patterns from settings and a committed .shushrc.json, and swaps matching
// ABOUTME: files into the redacted editor so their values never stay on screen.

import * as vscode from "vscode";
import { RedactedEnvEditorProvider } from "./ui/redactedEditor";
import { basename, matchesAny } from "./core/glob";
import { ENABLED_KEY, HistoryStore, MAX_VERSIONS_KEY } from "./history/store";
import { HistoryPanel } from "./ui/historyPanel";

const CONFIG_FILE = ".shushrc.json";

/** URIs the user has explicitly chosen to view as plain text this session. */
const textAllowed = new Set<string>();
/** URIs currently being swapped into the redacted editor (avoids re-entrancy). */
const inFlight = new Set<string>();

/** Loads and caches the extra patterns from settings + committed config files. */
class ConfigStore {
  private patterns: string[] = [];

  async reload(): Promise<void> {
    const fromSettings = vscode.workspace
      .getConfiguration("shush")
      .get<string[]>("patterns", []);

    const fromFiles: string[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const uri = vscode.Uri.joinPath(folder.uri, CONFIG_FILE);
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { patterns?: unknown };
        if (Array.isArray(parsed.patterns)) {
          for (const p of parsed.patterns) {
            if (typeof p === "string") {
              fromFiles.push(p);
            }
          }
        }
      } catch {
        // no config file in this folder, or it's invalid — skip it
      }
    }

    this.patterns = [...new Set([...fromSettings, ...fromFiles])];
  }

  get extraPatterns(): string[] {
    return this.patterns;
  }
}

/** Swap a matching file into the redacted editor if it isn't already there. */
async function protectIfNeeded(uri: vscode.Uri, store: ConfigStore): Promise<void> {
  const key = uri.toString();
  if (
    inFlight.has(key) ||
    textAllowed.has(key) ||
    !matchesAny(uri, store.extraPatterns)
  ) {
    return;
  }
  inFlight.add(key);
  try {
    await vscode.commands.executeCommand(
      "vscode.openWith",
      uri,
      RedactedEnvEditorProvider.viewType
    );
  } finally {
    inFlight.delete(key);
  }
}

/** Re-check every open text tab — used on activation and whenever patterns change. */
function sweepOpenTabs(store: ConfigStore): void {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText) {
        void protectIfNeeded(tab.input.uri, store);
      }
    }
  }
}

async function addPattern(pattern: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage("Shush: open a folder first to save a config.");
    return;
  }
  const uri = vscode.Uri.joinPath(folder.uri, CONFIG_FILE);
  let config: { patterns: string[] } = { patterns: [] };
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { patterns?: unknown };
    config = {
      patterns: Array.isArray(parsed.patterns)
        ? parsed.patterns.filter((p): p is string => typeof p === "string")
        : [],
    };
  } catch {
    // starting a fresh config
  }
  if (config.patterns.includes(pattern)) {
    void vscode.window.showInformationMessage(`Shush: "${pattern}" is already protected.`);
    return;
  }
  config.patterns.push(pattern);
  const body = JSON.stringify(config, null, 2) + "\n";
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(body));
  void vscode.window.showInformationMessage(
    `Shush: protecting "${pattern}". Commit ${CONFIG_FILE} to share it with your team.`
  );
}

/**
 * History keeps copies of secrets alive after the file changes, so the first time
 * it is switched on we say plainly where those copies live and let the user back out.
 */
async function confirmHistoryOptIn(history: HistoryStore): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    "Shush will now keep a version history of protected files.",
    {
      modal: true,
      detail:
        "Snapshots are stored encrypted in your OS credential store (Keychain on macOS, " +
        "Credential Manager on Windows, gnome-keyring/KWallet on Linux) — never in the " +
        "workspace, so they can't be committed. They stay on this machine and are readable " +
        "by anything running as you. On Linux without a keyring, VS Code falls back to a " +
        "weaker local store.\n\nRun \"Shush: Delete all stored version history\" to purge.",
    },
    "Keep history on",
    "Turn it back off"
  );
  if (choice !== "Keep history on") {
    await vscode.workspace
      .getConfiguration()
      .update(ENABLED_KEY, false, vscode.ConfigurationTarget.Global);
    await history.clearAll(openProtectedUris());
    HistoryPanel.closeAll();
  }
}

/**
 * Turning history off stops new snapshots but leaves the existing ones in the
 * credential store, where nothing in the UI would show them any more. Offer to
 * delete them, because "off" reasonably reads as "gone".
 */
async function offerPurgeOnDisable(history: HistoryStore): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    "Version history is off. Snapshots already taken are still stored.",
    { modal: true, detail: "Delete them now, or keep them in case you turn history back on." },
    "Delete them",
    "Keep them"
  );
  if (choice === "Delete them") {
    const count = await history.clearAll(openProtectedUris());
    HistoryPanel.closeAll();
    void vscode.window.showInformationMessage(
      `Shush: cleared stored history for ${count} file${count === 1 ? "" : "s"}.`
    );
  }
}

/** URIs currently open in the redacted editor — a safety net for `clearAll`. */
function openProtectedUris(): string[] {
  const uris: string[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (
        tab.input instanceof vscode.TabInputCustom &&
        tab.input.viewType === RedactedEnvEditorProvider.viewType
      ) {
        uris.push(tab.input.uri.toString());
      }
    }
  }
  return uris;
}

export function activate(context: vscode.ExtensionContext): void {
  const store = new ConfigStore();
  const history = new HistoryStore(context.secrets, () => {
    const config = vscode.workspace.getConfiguration();
    return {
      enabled: config.get<boolean>(ENABLED_KEY, false),
      maxVersions: config.get<number>(MAX_VERSIONS_KEY, 10),
    };
  });
  context.subscriptions.push(RedactedEnvEditorProvider.register(context, history));

  void store.reload().then(() => sweepOpenTabs(store));

  // React to newly opened tabs.
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.opened) {
        if (tab.input instanceof vscode.TabInputText) {
          void protectIfNeeded(tab.input.uri, store);
        }
      }
      for (const tab of e.closed) {
        if (tab.input instanceof vscode.TabInputText) {
          textAllowed.delete(tab.input.uri.toString());
        }
      }
    })
  );

  // Reload patterns when settings or a .shushrc.json change.
  const reloadAndSweep = () => void store.reload().then(() => sweepOpenTabs(store));
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILE}`);
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(reloadAndSweep),
    watcher.onDidCreate(reloadAndSweep),
    watcher.onDidDelete(reloadAndSweep),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("shush.patterns")) {
        reloadAndSweep();
      }
      if (e.affectsConfiguration(ENABLED_KEY)) {
        void (history.enabled ? confirmHistoryOptIn(history) : offerPurgeOnDisable(history));
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(reloadAndSweep)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("shush.openAsText", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        return;
      }
      textAllowed.add(target.toString());
      await vscode.commands.executeCommand("vscode.openWith", target, "default");
    }),

    vscode.commands.registerCommand("shush.protectActiveFile", async () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      let uri: vscode.Uri | undefined;
      if (tab?.input instanceof vscode.TabInputText) {
        uri = tab.input.uri;
      } else if (tab?.input instanceof vscode.TabInputCustom) {
        uri = tab.input.uri;
      } else {
        uri = vscode.window.activeTextEditor?.document.uri;
      }
      if (!uri) {
        void vscode.window.showErrorMessage("Shush: no active file to protect.");
        return;
      }
      const name = basename(uri.path);
      const pattern = await vscode.window.showInputBox({
        title: "Shush: protect a file pattern",
        prompt: "Glob pattern to redact (committed to .shushrc.json).",
        value: `**/${name}`,
      });
      if (pattern) {
        await addPattern(pattern.trim());
        await store.reload();
        sweepOpenTabs(store);
      }
    }),

    // A setting alone would be invisible from the command palette.
    vscode.commands.registerCommand("shush.toggleHistory", async () => {
      const turningOn = !history.enabled;
      await vscode.workspace
        .getConfiguration()
        .update(ENABLED_KEY, turningOn, vscode.ConfigurationTarget.Global);
      if (!turningOn) {
        void vscode.window.showInformationMessage("Shush: version history is off.");
      }
    }),

    vscode.commands.registerCommand("shush.clearHistory", async () => {
      const confirm = await vscode.window.showWarningMessage(
        "Delete every version snapshot Shush has stored?",
        { modal: true, detail: "This cannot be undone." },
        "Delete all"
      );
      if (confirm !== "Delete all") {
        return;
      }
      const count = await history.clearAll(openProtectedUris());
      HistoryPanel.closeAll(); // an open history tab would outlive the data it shows
      void vscode.window.showInformationMessage(
        `Shush: cleared stored history for ${count} file${count === 1 ? "" : "s"}.`
      );
    }),

    vscode.commands.registerCommand("shush.openConfig", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode.window.showErrorMessage("Shush: open a folder first.");
        return;
      }
      const uri = vscode.Uri.joinPath(folder.uri, CONFIG_FILE);
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        const body = JSON.stringify({ patterns: [] }, null, 2) + "\n";
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(body));
      }
      textAllowed.add(uri.toString());
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
    })
  );
}

export function deactivate(): void {
  textAllowed.clear();
  inFlight.clear();
}
