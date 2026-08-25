// ABOUTME: A CustomTextEditor that renders secret files with values masked by default.
// ABOUTME: Handles env (KEY=VALUE) files and JSON files (key-aware leaf redaction).

import * as vscode from "vscode";
import { HistoryStore } from "./history";
import {
  envKeyName,
  isUnsafeJsonSegment,
  isValidEnvKey,
  sanitizeEnvValue,
  type SnapshotMeta,
} from "./model";
import { randomBytes } from "node:crypto";
import { diffEntries, type DiffRow, type Entry } from "./diff";
import { HistoryPanel } from "./historyPanel";
import { filterRows } from "./search";

type Format = "env" | "json";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonContainer = JsonValue[] | { [key: string]: JsonValue };

function isContainer(value: JsonValue): value is JsonContainer {
  return value !== null && typeof value === "object";
}

function childAt(node: JsonContainer, token: string | number): JsonValue | undefined {
  return Array.isArray(node)
    ? node[Number(token)]
    : (node as Record<string, JsonValue>)[String(token)];
}

function setChild(node: JsonContainer, token: string | number, value: JsonValue): void {
  if (Array.isArray(node)) {
    node[Number(token)] = value;
  } else {
    (node as Record<string, JsonValue>)[String(token)] = value;
  }
}

/** Parse a document's JSON, or undefined when it isn't valid. */
function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

function leafText(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** A row shown in the webview — either a leaf value or a container header. */
interface Row {
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

interface Parsed {
  format: Format;
  rows: Row[];
  /** Set when a JSON file could not be parsed; contents are shown as one masked block. */
  note?: string;
}

function detectFormat(document: vscode.TextDocument): Format {
  if (document.languageId === "json" || document.languageId === "jsonc") {
    return "json";
  }
  if (document.uri.path.toLowerCase().endsWith(".json")) {
    return "json";
  }
  return "env";
}

// ---- env parsing ---------------------------------------------------------

interface EnvLine {
  line: number;
  key: string;
  sep: string;
  value: string;
}

function parseEnvLine(text: string, line: number): EnvLine | null {
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
function buildRows(
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
function pathTokens(path: string): (string | number)[] {
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
function coerce(previous: JsonValue | undefined, next: string): JsonValue {
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

function fullRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length)
  );
}

function detectIndent(text: string): number | string {
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
function parseText(text: string, format: Format): Parsed {
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
function toEntries(rows: Row[], format: Format): Entry[] {
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
interface WebviewMessage {
  type: string;
  id?: unknown;
  value?: unknown;
  at?: unknown;
}

function asMessage(raw: unknown): WebviewMessage | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }
  const msg = raw as Partial<WebviewMessage>;
  return typeof msg.type === "string" ? (msg as WebviewMessage) : undefined;
}

/** Compact timestamp for tab titles and column headers. */
function stamp(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---- provider ------------------------------------------------------------

export class RedactedEnvEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "shush.redactedEditor";

  public static register(
    context: vscode.ExtensionContext,
    history: HistoryStore
  ): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      RedactedEnvEditorProvider.viewType,
      new RedactedEnvEditorProvider(history),
      { webviewOptions: { retainContextWhenHidden: false } }
    );
  }

  constructor(private readonly history: HistoryStore) {}

  private parse(document: vscode.TextDocument): Parsed {
    return parseText(document.getText(), detectFormat(document));
  }

  public resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): void {
    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = this.html();

    const isThisDoc = (uri: vscode.Uri) => uri.toString() === document.uri.toString();

    const post = () => {
      const parsed = this.parse(document);
      void webviewPanel.webview.postMessage({
        type: "load",
        rows: parsed.rows,
        note: parsed.note,
        format: parsed.format,
        historyEnabled: this.history.enabled,
        fileName: document.uri.path.split("/").pop(),
      });
    };

    const postVersions = async () => {
      const versions: SnapshotMeta[] = this.history.enabled
        ? await this.history.list(document.uri.toString())
        : [];
      void webviewPanel.webview.postMessage({ type: "versions", versions });
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (isThisDoc(e.document.uri)) {
        post();
      }
    });

    // Only files opened in this editor are snapshotted — i.e. files Shush protects.
    const saveSub = vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (!isThisDoc(doc.uri)) {
        return;
      }
      await this.captureNow(doc);
      await postVersions();
    });

    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("shush.history")) {
        post();
        void postVersions();
      }
    });

    webviewPanel.onDidDispose(() => {
      changeSub.dispose();
      saveSub.dispose();
      configSub.dispose();
    });

    webviewPanel.webview.onDidReceiveMessage(async (raw: unknown) => {
      const msg = asMessage(raw);
      if (!msg) {
        return;
      }
      if (msg.type === "ready") {
        post();
        await postVersions();
      } else if (msg.type === "edit") {
        await this.applyEdit(document, String(msg.id), String(msg.value));
      } else if (msg.type === "openText") {
        await vscode.commands.executeCommand("shush.openAsText", document.uri);
      } else if (msg.type === "add") {
        await this.addValue(document);
      } else if (msg.type === "toggleHistory") {
        await vscode.commands.executeCommand("shush.toggleHistory");
      } else if (msg.type === "versions") {
        await postVersions();
      } else if (msg.type === "diffVersion") {
        await this.openHistoryTab(document, String(msg.at), "current");
      } else if (msg.type === "restoreVersion") {
        await this.restoreVersion(document, Number(msg.at));
        await postVersions();
      } else if (msg.type === "clearHistory") {
        await this.history.clearFile(document.uri.toString());
        await postVersions();
      }
    });
  }

  /** Files we've already warned about, so a failing keychain nags once, not on every save. */
  private readonly warned = new Set<string>();

  /**
   * Snapshot a save. Failures are surfaced rather than swallowed: silently not
   * recording, while the user believes history is on, is the worst outcome here.
   */
  private async captureNow(doc: vscode.TextDocument): Promise<void> {
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

  /**
   * Add a new key/value. Both prompts run in VS Code's own input box rather than
   * in the webview so the value can use `password: true` — typing a fresh secret
   * into a visible field would leak exactly what this extension exists to hide.
   */
  private async addValue(document: vscode.TextDocument): Promise<void> {
    const format = detectFormat(document);
    let parentPath = "";
    /** Names already present at the insertion point — adding over one would destroy a secret. */
    let taken: Set<string>;
    let intoArray = false;

    if (format === "json") {
      const target = await this.pickJsonParent(document);
      if (target === undefined) {
        return;
      }
      parentPath = target.path;
      intoArray = target.isArray;
      taken = new Set(target.keys);
    } else {
      taken = new Set(this.parse(document).rows.map((r) => envKeyName(r.label)));
    }

    // An array has no key to ask for — the new value is appended.
    let key = "";
    if (!intoArray) {
      const input = await vscode.window.showInputBox({
        title: "Shush: add a value",
        prompt: format === "env" ? "Variable name" : `Key to add under ${parentPath || "the root"}`,
        validateInput: (raw) => {
          const k = raw.trim();
          if (!k) {
            return "A name is required.";
          }
          if (format === "env" && !isValidEnvKey(k)) {
            return "Use letters, digits, _ . - and start with a letter or underscore.";
          }
          if (taken.has(k)) {
            return `"${k}" already exists here — edit it instead of overwriting it.`;
          }
          if (format === "json" && isUnsafeJsonSegment(k)) {
            return `"${k}" can't be used as a key.`;
          }
          return null;
        },
      });
      if (!input) {
        return;
      }
      key = input.trim();
    }

    const value = await vscode.window.showInputBox({
      title: "Shush: add a value",
      prompt: intoArray
        ? `New item in ${parentPath} (hidden while you type)`
        : `Value for ${key} (hidden while you type)`,
      password: true,
    });
    if (value === undefined) {
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    if (format === "json") {
      const next = this.insertJsonKey(document, parentPath, key, value);
      if (next === undefined) {
        void vscode.window.showErrorMessage("Shush: couldn't add that key.");
        return;
      }
      edit.replace(document.uri, fullRange(document), next);
    } else {
      const text = document.getText();
      const needsNewline = text.length > 0 && !text.endsWith("\n");
      const line = `${needsNewline ? "\n" : ""}${key}=${sanitizeEnvValue(value)}\n`;
      edit.insert(document.uri, document.positionAt(text.length), line);
    }
    await vscode.workspace.applyEdit(edit);
  }

  /** Offer every object/array in the document as an insertion point. */
  private async pickJsonParent(
    document: vscode.TextDocument
  ): Promise<{ path: string; isArray: boolean; keys: string[] } | undefined> {
    const root = parseJson(document.getText());
    if (root === undefined) {
      void vscode.window.showErrorMessage("Shush: this JSON can't be parsed, so it isn't editable.");
      return undefined;
    }
    type Container = { path: string; isArray: boolean; keys: string[] };
    const containers: Container[] = [];
    const walk = (value: JsonValue, path: string): void => {
      if (!isContainer(value)) {
        return;
      }
      const isArray = Array.isArray(value);
      containers.push({ path, isArray, keys: isArray ? [] : Object.keys(value) });
      if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${path}[${i}]`));
      } else {
        for (const [k, v] of Object.entries(value)) {
          walk(v, path ? `${path}.${k}` : k);
        }
      }
    };
    walk(root, "");
    if (containers.length === 0) {
      void vscode.window.showErrorMessage("Shush: this file has no object to add a key to.");
      return undefined;
    }
    if (containers.length === 1) {
      return containers[0];
    }
    const picked = await vscode.window.showQuickPick(
      containers.map((c) => ({
        label: c.path || "(root)",
        description: c.isArray ? "array — appends an item" : undefined,
        container: c,
      })),
      { title: "Shush: where should the new value go?" }
    );
    return picked?.container;
  }

  /** Serialize the document with `key` added under `parentPath`, or undefined on failure. */
  private insertJsonKey(
    document: vscode.TextDocument,
    parentPath: string,
    key: string,
    value: string
  ): string | undefined {
    const text = document.getText();
    const root = parseJson(text);
    if (root === undefined || !isContainer(root)) {
      return undefined;
    }
    let node: JsonContainer = root;
    for (const token of parentPath ? pathTokens(parentPath) : []) {
      if (isUnsafeJsonSegment(token)) {
        return undefined;
      }
      const next = childAt(node, token);
      if (next === undefined || !isContainer(next)) {
        return undefined;
      }
      node = next;
    }
    if (Array.isArray(node)) {
      node.push(value);
    } else {
      node[key] = value;
    }
    return JSON.stringify(root, null, detectIndent(text));
  }

  /**
   * Render the history tab for a chosen pair. `before`/`after` are option values:
   * "none" (show one version only), "current" (the file as it stands), or a
   * snapshot timestamp. Repicking in the tab's dropdowns comes back through here.
   */
  private async openHistoryTab(
    document: vscode.TextDocument,
    before: string,
    after: string
  ): Promise<void> {
    const key = document.uri.toString();
    const format = detectFormat(document);
    const versions = await this.history.list(key);

    const sideContent = async (value: string): Promise<string | undefined> =>
      value === "current" ? document.getText() : this.history.contentAt(key, Number(value));

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
          ...versions.map((v) => ({ value: String(v.at), label: stamp(v.at) })),
        ],
        before,
        after,
      },
      {
        onSelect: (nextBefore, nextAfter) =>
          void this.openHistoryTab(document, nextBefore, nextAfter),
        onRestore: (target) => void this.restoreVersion(document, target),
      }
    );
  }

  /** Show what would change, then confirm. Seeing the diff first is the point. */
  private async restoreVersion(document: vscode.TextDocument, at: number): Promise<void> {
    const content = await this.history.contentAt(document.uri.toString(), at);
    if (content === undefined) {
      void vscode.window.showWarningMessage("Shush: that version is no longer stored.");
      return;
    }
    await this.openHistoryTab(document, String(at), "current");

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
    await this.captureNow(document);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullRange(document), content);
    await vscode.workspace.applyEdit(edit);
    await this.openHistoryTab(document, String(at), "current");
  }

  private async applyEdit(
    document: vscode.TextDocument,
    id: string,
    value: string
  ): Promise<void> {
    if (id === "__raw__") {
      return; // unparseable file — editing disabled
    }
    const format = detectFormat(document);
    const edit = new vscode.WorkspaceEdit();

    if (format === "json") {
      const root = parseJson(document.getText());
      if (root === undefined || !isContainer(root)) {
        return;
      }
      const tokens = pathTokens(id);
      if (tokens.some(isUnsafeJsonSegment)) {
        return; // would be silently dropped by the engine — refuse rather than lose the edit
      }
      let node: JsonContainer = root;
      for (let i = 0; i < tokens.length - 1; i++) {
        const next = childAt(node, tokens[i]);
        if (next === undefined || !isContainer(next)) {
          return;
        }
        node = next;
      }
      const leaf = tokens[tokens.length - 1];
      setChild(node, leaf, coerce(childAt(node, leaf), value));
      const indent = detectIndent(document.getText());
      const serialized = JSON.stringify(root, null, indent);
      if (serialized === document.getText()) {
        return;
      }
      edit.replace(document.uri, fullRange(document), serialized);
    } else {
      const line = Number(id.slice(1));
      if (!(line >= 0 && line < document.lineCount)) {
        return;
      }
      const parsed = parseEnvLine(document.lineAt(line).text, line);
      if (!parsed) {
        return;
      }
      const newText = `${parsed.key}${parsed.sep}${sanitizeEnvValue(value)}`;
      if (newText === document.lineAt(line).text) {
        return;
      }
      edit.replace(document.uri, document.lineAt(line).range, newText);
    }

    await vscode.workspace.applyEdit(edit);
  }

  private html(): string {
    const n = this.nonce();
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${n}'`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0; margin: 0; }
  .header { position: sticky; top: 0; z-index: 1; background: var(--vscode-editor-background); }
  .bar { display: flex; align-items: center; gap: 10px;
         padding: 10px 14px; background: var(--vscode-editor-background);
         border-bottom: 1px solid var(--vscode-panel-border); }
  .bar .name { font-weight: 600; margin-right: auto; }
  button { font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background);
           border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:hover { opacity: .9; }
  .note { padding: 8px 14px; background: var(--vscode-inputValidation-warningBackground, transparent);
          border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 6px 14px; vertical-align: middle; border-bottom: 1px solid var(--vscode-panel-border); }
  td.key { font-family: var(--vscode-editor-font-family); white-space: nowrap;
           color: var(--vscode-symbolIcon-variableForeground); }
  td.val { width: 100%; }
  tr.container td { font-family: var(--vscode-editor-font-family); font-weight: 600;
                    color: var(--vscode-foreground); opacity: .8; }
  .twisty { opacity: .5; margin-right: 4px; }
  input { width: 100%; box-sizing: border-box; font-family: var(--vscode-editor-font-family);
          color: var(--vscode-input-foreground); background: var(--vscode-input-background);
          border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 4px 8px; }
  .eye { background: transparent; color: var(--vscode-foreground); opacity: .65;
         padding: 4px 6px; display: inline-flex; align-items: center; }
  .eye:hover { opacity: 1; }
  .empty { padding: 24px 14px; opacity: .7; }
  .find { display: none; align-items: center; gap: 8px; padding: 8px 14px;
          background: var(--vscode-editor-background);
          border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px; }
  .find input[type=search] { flex: 1; min-width: 120px; }
  .find .scope { display: inline-flex; gap: 2px; }
  .find .scope button { padding: 3px 8px; font-size: 12px; }
  .find .scope button[aria-pressed=true] { color: var(--vscode-button-foreground);
                                           background: var(--vscode-button-background); }
  .find label { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; opacity: .85; }
  .find .count { white-space: nowrap; opacity: .7; min-width: 70px; text-align: right; }
  mark { background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,.33));
         color: inherit; border-radius: 2px; }
  .versions { display: none; border-bottom: 1px solid var(--vscode-panel-border);
              max-height: 40vh; overflow-y: auto; background: var(--vscode-editor-background); }
  .versions ul { list-style: none; margin: 0; padding: 4px 0; }
  .versions li { display: flex; align-items: center; gap: 8px; padding: 4px 14px; font-size: 12px; }
  .versions li .when { margin-right: auto; font-family: var(--vscode-editor-font-family); }
  .versions .hint { padding: 6px 14px; opacity: .7; font-size: 12px; }
</style>
</head>
<body>
  <div class="header">
  <div class="bar">
    <span class="name" id="name">secrets</span>
    <button class="secondary" id="add">+ Add value</button>
    <button class="secondary" id="findBtn" title="Find (Cmd/Ctrl+F)">Find</button>
    <button class="secondary" id="historyBtn">History</button>
    <button class="secondary" id="toggleAll">Reveal all</button>
    <button class="secondary" id="openText">Open as text</button>
  </div>
  <div class="find" id="find">
    <input type="password" id="q" placeholder="Filter by name or value…" spellcheck="false"
           autocomplete="off" aria-label="Filter rows">
    <button class="eye" id="qEye" title="Show / hide what you typed"></button>
    <span class="scope" id="scope">
      <button class="secondary" data-scope="both" aria-pressed="true">Both</button>
      <button class="secondary" data-scope="keys" aria-pressed="false">Names</button>
      <button class="secondary" data-scope="values" aria-pressed="false">Values</button>
    </span>
    <label><input type="checkbox" id="caseSensitive"> Match case</label>
    <span class="count" id="count"></span>
    <button class="secondary" id="findClose" title="Close (Esc)">✕</button>
  </div>
  <div class="versions" id="versions"></div>
  </div>
  <div class="note" id="note" style="display:none"></div>
  <table id="rows"></table>
  <div class="empty" id="empty" style="display:none">No values found to redact.</div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  let allRevealed = false;
  let historyEnabled = false;
  let allRows = [];
  let query = '';
  let scope = 'both';
  let caseSensitive = false;

  // The extension's own filter, embedded verbatim so the tested implementation
  // and the one the webview runs cannot drift apart. Bound to a const because the
  // production build minifies the declaration's name away.
  const filterRows = ${filterRows.toString()};

  const saved = vscode.getState() || {};
  if (saved.scope === 'keys' || saved.scope === 'values' || saved.scope === 'both') {
    scope = saved.scope;
  }
  caseSensitive = !!saved.caseSensitive;

  function saveSettings() {
    vscode.setState({ scope: scope, caseSensitive: caseSensitive });
  }

  // Feather icons (MIT) — inline so they render identically on every platform.
  const EYE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  /** Key text with the matched span marked. Values are never highlighted — they stay masked. */
  function labelInto(td, text) {
    const hay = caseSensitive ? text : text.toLowerCase();
    const q = query.trim();
    const needle = caseSensitive ? q : q.toLowerCase();
    let at = needle && scope !== 'values' ? hay.indexOf(needle) : -1;
    if (at === -1) {
      td.appendChild(document.createTextNode(text));
      return;
    }
    let from = 0;
    while (at !== -1) {
      td.appendChild(document.createTextNode(text.slice(from, at)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(at, at + needle.length);
      td.appendChild(mark);
      from = at + needle.length;
      at = hay.indexOf(needle, from);
    }
    td.appendChild(document.createTextNode(text.slice(from)));
  }

  function render() {
    const table = document.getElementById('rows');
    // Rebuilding drops the inputs, and a removed input never fires 'change' — commit
    // whatever is being typed first, or filtering would silently discard the edit.
    const active = document.activeElement;
    if (active && active.tagName === 'INPUT' && active.closest('#rows')) {
      active.blur();
    }
    table.innerHTML = '';
    const result = filterRows(allRows, query, scope, caseSensitive);
    const rows = allRows.filter((_, i) => result.keep[i]);

    const empty = document.getElementById('empty');
    empty.style.display = rows.length ? 'none' : 'block';
    // Never echo the query: in Values scope it is a secret the user pasted in.
    empty.textContent = allRows.length ? 'No rows match your filter.' : 'No values found to redact.';

    const count = document.getElementById('count');
    count.textContent = query.trim()
      ? result.matches + (result.matches === 1 ? ' match' : ' matches')
      : '';

    for (const r of rows) {
      const indent = (r.depth || 0) * 16;

      if (r.container) {
        const tr = document.createElement('tr');
        tr.className = 'container';
        const td = document.createElement('td');
        td.colSpan = 3;
        td.style.paddingLeft = (14 + indent) + 'px';
        td.innerHTML = '<span class="twisty">▸</span>';
        labelInto(td, r.label);
        tr.appendChild(td);
        table.appendChild(tr);
        continue;
      }

      const tr = document.createElement('tr');

      const kd = document.createElement('td');
      kd.className = 'key';
      kd.style.paddingLeft = (14 + indent) + 'px';
      labelInto(kd, r.label);
      tr.appendChild(kd);

      const vd = document.createElement('td');
      vd.className = 'val';
      const input = document.createElement('input');
      input.type = allRevealed ? 'text' : 'password';
      input.value = r.value;
      input.spellcheck = false;
      input.dataset.id = r.id;
      input.addEventListener('change', () => {
        vscode.postMessage({ type: 'edit', id: r.id, value: input.value });
      });
      vd.appendChild(input);
      tr.appendChild(vd);

      const ed = document.createElement('td');
      const eye = document.createElement('button');
      eye.className = 'eye';
      eye.title = 'Show / hide this value';
      eye.innerHTML = input.type === 'password' ? EYE : EYE_OFF;
      eye.addEventListener('click', () => {
        input.type = input.type === 'password' ? 'text' : 'password';
        eye.innerHTML = input.type === 'password' ? EYE : EYE_OFF;
      });
      ed.appendChild(eye);
      tr.appendChild(ed);

      table.appendChild(tr);
    }
  }

  function renderVersions(versions) {
    const box = document.getElementById('versions');
    box.innerHTML = '';
    if (!historyEnabled) {
      const p = document.createElement('div');
      p.className = 'hint';
      p.textContent =
        'Version history is off. When on, Shush keeps a snapshot of this file each time ' +
        'you save it, encrypted in your OS credential store — never in the project folder.';
      box.appendChild(p);
      const wrap = document.createElement('div');
      wrap.className = 'hint';
      const on = document.createElement('button');
      on.textContent = 'Turn on version history';
      on.addEventListener('click', () => vscode.postMessage({ type: 'toggleHistory' }));
      wrap.appendChild(on);
      box.appendChild(wrap);
      return;
    }
    if (!versions.length) {
      const p = document.createElement('div');
      p.className = 'hint';
      p.textContent = 'No versions stored yet. A version is kept each time you save this file.';
      box.appendChild(p);
      return;
    }
    const ul = document.createElement('ul');
    for (const v of versions) {
      const li = document.createElement('li');
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = new Date(v.at).toLocaleString();
      li.appendChild(when);

      const diff = document.createElement('button');
      diff.className = 'secondary';
      diff.textContent = 'Diff';
      diff.title = 'Compare this version with the current file, in its own tab';
      diff.addEventListener('click', () => vscode.postMessage({ type: 'diffVersion', at: v.at }));
      li.appendChild(diff);

      const restore = document.createElement('button');
      restore.className = 'secondary';
      restore.textContent = 'Restore';
      restore.title = 'Show what would change, then restore';
      restore.addEventListener('click', () =>
        vscode.postMessage({ type: 'restoreVersion', at: v.at }));
      li.appendChild(restore);

      ul.appendChild(li);
    }
    box.appendChild(ul);

    const clear = document.createElement('div');
    clear.className = 'hint';
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.textContent = 'Delete history for this file';
    btn.addEventListener('click', () => vscode.postMessage({ type: 'clearHistory' }));
    clear.appendChild(btn);
    box.appendChild(clear);
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'load') {
      document.getElementById('name').textContent = m.fileName || 'secrets';
      historyEnabled = !!m.historyEnabled;
      const note = document.getElementById('note');
      if (m.note) { note.textContent = m.note; note.style.display = 'block'; }
      else { note.style.display = 'none'; }
      allRows = m.rows || [];
      render();
    } else if (m.type === 'versions') {
      renderVersions(m.versions || []);
    }
  });

  document.getElementById('add').addEventListener('click', () => {
    vscode.postMessage({ type: 'add' });
  });

  document.getElementById('historyBtn').addEventListener('click', () => {
    const box = document.getElementById('versions');
    const open = box.style.display === 'block';
    box.style.display = open ? 'none' : 'block';
    if (!open) { vscode.postMessage({ type: 'versions' }); }
  });


  document.getElementById('toggleAll').addEventListener('click', () => {
    allRevealed = !allRevealed;
    document.getElementById('toggleAll').textContent = allRevealed ? 'Hide all' : 'Reveal all';
    document.querySelectorAll('#rows input').forEach((inp) => {
      inp.type = allRevealed ? 'text' : 'password';
      const eye = inp.parentElement.parentElement.querySelector('.eye');
      if (eye) eye.innerHTML = allRevealed ? EYE_OFF : EYE;
    });
  });

  document.getElementById('openText').addEventListener('click', () => {
    vscode.postMessage({ type: 'openText' });
  });

  // ---- find bar ----------------------------------------------------------

  const findBar = document.getElementById('find');
  const qInput = document.getElementById('q');
  const caseBox = document.getElementById('caseSensitive');

  function paintScope() {
    document.querySelectorAll('#scope button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.scope === scope));
    });
  }

  const qEye = document.getElementById('qEye');
  let qRevealed = false;

  /** The query is a secret whenever it's matched against values — mask it like one. */
  function paintQueryMask() {
    const secret = scope !== 'keys';
    qInput.type = secret && !qRevealed ? 'password' : 'text';
    qEye.style.display = secret ? 'inline-flex' : 'none';
    qEye.innerHTML = qInput.type === 'password' ? EYE : EYE_OFF;
  }

  qEye.addEventListener('click', () => {
    qRevealed = !qRevealed;
    paintQueryMask();
    qInput.focus();
  });

  function openFind() {
    findBar.style.display = 'flex';
    qInput.focus();
    qInput.select();
  }

  function closeFind() {
    findBar.style.display = 'none';
    qInput.value = '';
    query = '';
    qRevealed = false;
    paintQueryMask();
    render();
  }

  qInput.value = query;
  caseBox.checked = caseSensitive;
  paintScope();
  paintQueryMask();

  qInput.addEventListener('input', () => {
    query = qInput.value;
    render();
  });

  caseBox.addEventListener('change', () => {
    caseSensitive = caseBox.checked;
    saveSettings();
    render();
  });

  document.querySelectorAll('#scope button').forEach((b) => {
    b.addEventListener('click', () => {
      scope = b.dataset.scope;
      qRevealed = false;
      paintScope();
      paintQueryMask();
      saveSettings();
      render();
      qInput.focus();
    });
  });

  document.getElementById('findBtn').addEventListener('click', () => {
    findBar.style.display === 'flex' ? closeFind() : openFind();
  });
  document.getElementById('findClose').addEventListener('click', closeFind);

  // VS Code's own find widget is off for this panel, so Cmd/Ctrl+F is ours to take —
  // and the native one could not see values inside password fields anyway.
  const isMac = navigator.platform.toLowerCase().indexOf('mac') === 0;

  window.addEventListener('keydown', (e) => {
    if (typeof e.key !== 'string') {
      return;
    }
    // On macOS, Ctrl+F is "move cursor forward" inside a field — leave it alone there.
    const editing = document.activeElement && document.activeElement.closest('#rows');
    const claimed = e.metaKey || (e.ctrlKey && !(isMac && editing));
    if (claimed && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openFind();
    } else if (e.key === 'Escape' && findBar.style.display === 'flex') {
      e.preventDefault();
      closeFind();
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }

  private nonce(): string {
    return randomBytes(16).toString("base64");
  }
}
