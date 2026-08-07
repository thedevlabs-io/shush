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

type Format = "env" | "json";

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
  value: unknown,
  label: string | null,
  depth: number,
  id: string,
  out: Row[]
): void {
  if (value !== null && typeof value === "object") {
    if (label !== null) {
      out.push({ depth, label, container: true });
    }
    const childDepth = label === null ? depth : depth + 1;
    if (Array.isArray(value)) {
      value.forEach((v, i) =>
        buildRows(v, `[${i}]`, childDepth, id ? `${id}[${i}]` : `[${i}]`, out)
      );
    } else {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        buildRows(v, k, childDepth, id ? `${id}.${k}` : k, out);
      }
    }
    return;
  }
  out.push({
    depth,
    label: label ?? "",
    id,
    value: value === null ? "null" : String(value),
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
function coerce(previous: unknown, next: string): unknown {
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
    try {
      const rows: Row[] = [];
      buildRows(JSON.parse(text), null, 0, "", rows);
      return { format, rows };
    } catch {
      return {
        format,
        rows: [{ depth: 0, label: "(entire file)", id: "__raw__", value: text }],
        note: "This JSON couldn't be parsed, so the whole file is masked.",
      };
    }
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
    webviewPanel.webview.html = this.html(webviewPanel.webview);

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

    // Snapshot on save, and only for files already open in this editor — i.e. files
    // Shush protects. Nothing is recorded for files the user never opened here.
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

    webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "ready") {
        post();
        await postVersions();
      } else if (msg.type === "edit") {
        await this.applyEdit(document, String(msg.id), String(msg.value));
      } else if (msg.type === "openText") {
        await vscode.commands.executeCommand("shush.openAsText", document.uri);
      } else if (msg.type === "add") {
        await this.addValue(document);
      } else if (msg.type === "versions") {
        await postVersions();
      } else if (msg.type === "showVersion") {
        await this.showVersion(webviewPanel, document, Number(msg.at));
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
    let root: unknown;
    try {
      root = JSON.parse(document.getText());
    } catch {
      void vscode.window.showErrorMessage("Shush: this JSON can't be parsed, so it isn't editable.");
      return undefined;
    }
    type Container = { path: string; isArray: boolean; keys: string[] };
    const containers: Container[] = [];
    const walk = (value: unknown, path: string): void => {
      if (value === null || typeof value !== "object") {
        return;
      }
      const isArray = Array.isArray(value);
      containers.push({
        path,
        isArray,
        keys: isArray ? [] : Object.keys(value as Record<string, unknown>),
      });
      if (isArray) {
        (value as unknown[]).forEach((v, i) => walk(v, `${path}[${i}]`));
      } else {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
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
    let root: unknown;
    try {
      root = JSON.parse(text);
    } catch {
      return undefined;
    }
    let node: any = root;
    for (const token of parentPath ? pathTokens(parentPath) : []) {
      if (isUnsafeJsonSegment(token)) {
        return undefined;
      }
      node = node?.[token];
      if (node === null || typeof node !== "object") {
        return undefined;
      }
    }
    if (Array.isArray(node)) {
      node.push(value);
    } else if (node !== null && typeof node === "object") {
      node[key] = value;
    } else {
      return undefined;
    }
    return JSON.stringify(root, null, detectIndent(text));
  }

  private async showVersion(
    panel: vscode.WebviewPanel,
    document: vscode.TextDocument,
    at: number
  ): Promise<void> {
    const content = await this.history.contentAt(document.uri.toString(), at);
    if (content === undefined) {
      void vscode.window.showWarningMessage("Shush: that version is no longer stored.");
      return;
    }
    const parsed = parseText(content, detectFormat(document));
    void panel.webview.postMessage({
      type: "versionRows",
      at,
      rows: parsed.rows,
      note: parsed.note,
    });
  }

  private async restoreVersion(document: vscode.TextDocument, at: number): Promise<void> {
    const content = await this.history.contentAt(document.uri.toString(), at);
    if (content === undefined) {
      void vscode.window.showWarningMessage("Shush: that version is no longer stored.");
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Replace ${document.uri.path.split("/").pop()} with the version from ${new Date(at).toLocaleString()}?`,
      { modal: true, detail: "The current contents are snapshotted first, so this is reversible." },
      "Restore"
    );
    if (confirm !== "Restore") {
      return;
    }
    await this.captureNow(document);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullRange(document), content);
    await vscode.workspace.applyEdit(edit);
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
      let root: unknown;
      try {
        root = JSON.parse(document.getText());
      } catch {
        return;
      }
      const tokens = pathTokens(id);
      if (tokens.some(isUnsafeJsonSegment)) {
        return; // would be silently dropped by the engine — refuse rather than lose the edit
      }
      let node: any = root;
      for (let i = 0; i < tokens.length - 1; i++) {
        node = node?.[tokens[i]];
        if (node === undefined || node === null) {
          return;
        }
      }
      const leaf = tokens[tokens.length - 1];
      node[leaf] = coerce(node[leaf], value);
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

  private html(webview: vscode.Webview): string {
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
  .bar { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 10px;
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
  .banner { display: none; align-items: center; gap: 10px; padding: 8px 14px; font-size: 12px;
            background: var(--vscode-inputValidation-warningBackground, transparent);
            border-bottom: 1px solid var(--vscode-panel-border); }
  .banner .when { margin-right: auto; }
  .versions { display: none; border-bottom: 1px solid var(--vscode-panel-border); }
  .versions ul { list-style: none; margin: 0; padding: 4px 0; }
  .versions li { display: flex; align-items: center; gap: 8px; padding: 4px 14px; font-size: 12px; }
  .versions li .when { margin-right: auto; font-family: var(--vscode-editor-font-family); }
  .versions .hint { padding: 6px 14px; opacity: .7; font-size: 12px; }
</style>
</head>
<body>
  <div class="bar">
    <span class="name" id="name">secrets</span>
    <button class="secondary" id="add">+ Add value</button>
    <button class="secondary" id="historyBtn" style="display:none">History</button>
    <button class="secondary" id="toggleAll">Reveal all</button>
    <button class="secondary" id="openText">Open as text</button>
  </div>
  <div class="banner" id="banner">
    <span class="when" id="bannerWhen"></span>
    <button id="restore">Restore this version</button>
    <button class="secondary" id="backToCurrent">Back to current</button>
  </div>
  <div class="versions" id="versions"></div>
  <div class="note" id="note" style="display:none"></div>
  <table id="rows"></table>
  <div class="empty" id="empty" style="display:none">No values found to redact.</div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  let allRevealed = false;
  /** null while showing the file itself; a timestamp while previewing a stored version. */
  let viewingAt = null;

  // Feather icons (MIT) — inline so they render identically on every platform.
  const EYE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function render(rows, readOnly) {
    const table = document.getElementById('rows');
    table.innerHTML = '';
    document.getElementById('empty').style.display = rows.length ? 'none' : 'block';
    for (const r of rows) {
      const indent = (r.depth || 0) * 16;

      if (r.container) {
        const tr = document.createElement('tr');
        tr.className = 'container';
        const td = document.createElement('td');
        td.colSpan = 3;
        td.style.paddingLeft = (14 + indent) + 'px';
        td.innerHTML = '<span class="twisty">▸</span>';
        td.appendChild(document.createTextNode(r.label));
        tr.appendChild(td);
        table.appendChild(tr);
        continue;
      }

      const tr = document.createElement('tr');

      const kd = document.createElement('td');
      kd.className = 'key';
      kd.style.paddingLeft = (14 + indent) + 'px';
      kd.textContent = r.label;
      tr.appendChild(kd);

      const vd = document.createElement('td');
      vd.className = 'val';
      const input = document.createElement('input');
      input.type = allRevealed ? 'text' : 'password';
      input.value = r.value;
      input.spellcheck = false;
      input.dataset.id = r.id;
      if (readOnly) {
        input.readOnly = true;
      } else {
        input.addEventListener('change', () => {
          vscode.postMessage({ type: 'edit', id: r.id, value: input.value });
        });
      }
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

      const view = document.createElement('button');
      view.className = 'secondary';
      view.textContent = 'View';
      view.addEventListener('click', () => vscode.postMessage({ type: 'showVersion', at: v.at }));
      li.appendChild(view);

      const restore = document.createElement('button');
      restore.className = 'secondary';
      restore.textContent = 'Restore';
      restore.addEventListener('click', () => vscode.postMessage({ type: 'restoreVersion', at: v.at }));
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

  function showCurrent() {
    viewingAt = null;
    document.getElementById('banner').style.display = 'none';
    vscode.postMessage({ type: 'ready' });
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'load') {
      document.getElementById('name').textContent = m.fileName || 'secrets';
      document.getElementById('historyBtn').style.display = m.historyEnabled ? '' : 'none';
      if (!m.historyEnabled) {
        document.getElementById('versions').style.display = 'none';
      }
      const note = document.getElementById('note');
      if (m.note) { note.textContent = m.note; note.style.display = 'block'; }
      else { note.style.display = 'none'; }
      if (viewingAt === null) { render(m.rows, false); }
    } else if (m.type === 'versions') {
      renderVersions(m.versions || []);
    } else if (m.type === 'versionRows') {
      viewingAt = m.at;
      document.getElementById('banner').style.display = 'flex';
      document.getElementById('bannerWhen').textContent =
        'Viewing the version saved ' + new Date(m.at).toLocaleString() + ' — read-only.';
      render(m.rows, true);
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

  document.getElementById('backToCurrent').addEventListener('click', showCurrent);

  document.getElementById('restore').addEventListener('click', () => {
    if (viewingAt !== null) {
      vscode.postMessage({ type: 'restoreVersion', at: viewingAt });
      showCurrent();
    }
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

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }

  private nonce(): string {
    return randomBytes(16).toString("base64");
  }
}
