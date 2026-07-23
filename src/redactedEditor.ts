// ABOUTME: A CustomTextEditor that renders secret files with values masked by default.
// ABOUTME: Handles env (KEY=VALUE) files and JSON files (key-aware leaf redaction).

import * as vscode from "vscode";

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

function detectIndent(text: string): number | string {
  const m = /^(\t+|[ ]+)\S/m.exec(text);
  if (m) {
    return m[1][0] === "\t" ? "\t" : m[1].length;
  }
  return 2;
}

// ---- provider ------------------------------------------------------------

export class RedactedEnvEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "shush.redactedEditor";

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      RedactedEnvEditorProvider.viewType,
      new RedactedEnvEditorProvider(),
      { webviewOptions: { retainContextWhenHidden: false } }
    );
  }

  private parse(document: vscode.TextDocument): Parsed {
    const format = detectFormat(document);
    if (format === "json") {
      const text = document.getText();
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
    for (let i = 0; i < document.lineCount; i++) {
      const parsed = parseEnvLine(document.lineAt(i).text, i);
      if (parsed) {
        rows.push({ depth: 0, label: parsed.key.trim(), id: `L${parsed.line}`, value: parsed.value });
      }
    }
    return { format, rows };
  }

  public resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): void {
    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = this.html(webviewPanel.webview);

    const post = () => {
      const parsed = this.parse(document);
      void webviewPanel.webview.postMessage({
        type: "load",
        rows: parsed.rows,
        note: parsed.note,
        fileName: document.uri.path.split("/").pop(),
      });
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        post();
      }
    });
    webviewPanel.onDidDispose(() => changeSub.dispose());

    webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "ready") {
        post();
      } else if (msg.type === "edit") {
        await this.applyEdit(document, String(msg.id), String(msg.value));
      } else if (msg.type === "openText") {
        await vscode.commands.executeCommand("shush.openAsText", document.uri);
      }
    });
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
      const full = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
      );
      if (serialized === document.getText()) {
        return;
      }
      edit.replace(document.uri, full, serialized);
    } else {
      const line = Number(id.slice(1));
      if (!(line >= 0 && line < document.lineCount)) {
        return;
      }
      const parsed = parseEnvLine(document.lineAt(line).text, line);
      if (!parsed) {
        return;
      }
      const newText = `${parsed.key}${parsed.sep}${value}`;
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
</style>
</head>
<body>
  <div class="bar">
    <span class="name" id="name">secrets</span>
    <button class="secondary" id="toggleAll">Reveal all</button>
    <button class="secondary" id="openText">Open as text</button>
  </div>
  <div class="note" id="note" style="display:none"></div>
  <table id="rows"></table>
  <div class="empty" id="empty" style="display:none">No values found to redact.</div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  let allRevealed = false;

  // Feather icons (MIT) — inline so they render identically on every platform.
  const EYE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function render(rows) {
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

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'load') {
      document.getElementById('name').textContent = m.fileName || 'secrets';
      const note = document.getElementById('note');
      if (m.note) { note.textContent = m.note; note.style.display = 'block'; }
      else { note.style.display = 'none'; }
      render(m.rows);
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
    let s = "";
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      s += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return s;
  }
}
