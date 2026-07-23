// ABOUTME: A CustomTextEditor that renders .env files with values masked by default,
// ABOUTME: so secrets never render on screen until the user explicitly reveals them.

import * as vscode from "vscode";

interface Row {
  /** 0-based line number in the document. */
  line: number;
  key: string;
  /** Everything between key and value, e.g. " = " or "=". */
  sep: string;
  value: string;
}

/** Parse a line into a key/value row, or return null for comments/blanks. */
function parseLine(text: string, line: number): Row | null {
  if (/^\s*(#.*)?$/.test(text)) {
    return null; // blank or comment
  }
  const m = /^(\s*(?:export\s+)?[\w.-]+)(\s*=\s*)(.*)$/.exec(text);
  if (!m) {
    return null;
  }
  return { line, key: m[1], sep: m[2], value: m[3] };
}

function nonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export class RedactedEnvEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "blockEnvExpose.redactedEditor";

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      RedactedEnvEditorProvider.viewType,
      new RedactedEnvEditorProvider(),
      { webviewOptions: { retainContextWhenHidden: false } }
    );
  }

  public resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): void {
    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = this.html(webviewPanel.webview);

    const post = () => {
      const rows: Row[] = [];
      const other: { line: number; text: string }[] = [];
      for (let i = 0; i < document.lineCount; i++) {
        const text = document.lineAt(i).text;
        const row = parseLine(text, i);
        if (row) {
          rows.push(row);
        } else {
          other.push({ line: i, text });
        }
      }
      void webviewPanel.webview.postMessage({
        type: "load",
        rows,
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
        await this.applyEdit(document, msg.line, msg.value);
      } else if (msg.type === "openText") {
        await vscode.commands.executeCommand(
          "vscode.openWith",
          document.uri,
          "default"
        );
      }
    });
  }

  /** Replace the value portion of a single line, preserving key and separator. */
  private async applyEdit(
    document: vscode.TextDocument,
    line: number,
    value: string
  ): Promise<void> {
    if (line < 0 || line >= document.lineCount) {
      return;
    }
    const parsed = parseLine(document.lineAt(line).text, line);
    if (!parsed) {
      return;
    }
    const newText = `${parsed.key}${parsed.sep}${value}`;
    if (newText === document.lineAt(line).text) {
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, document.lineAt(line).range, newText);
    await vscode.workspace.applyEdit(edit);
  }

  private html(webview: vscode.Webview): string {
    const n = nonce();
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
  .bar { position: sticky; top: 0; display: flex; align-items: center; gap: 10px;
         padding: 10px 14px; background: var(--vscode-editor-background);
         border-bottom: 1px solid var(--vscode-panel-border); }
  .bar .name { font-weight: 600; margin-right: auto; }
  button { font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background);
           border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:hover { opacity: .9; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 6px 14px; vertical-align: middle; border-bottom: 1px solid var(--vscode-panel-border); }
  td.key { font-family: var(--vscode-editor-font-family); white-space: nowrap; color: var(--vscode-symbolIcon-variableForeground); }
  td.val { width: 100%; }
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
    <span class="name" id="name">.env</span>
    <button class="secondary" id="toggleAll">Reveal all</button>
    <button class="secondary" id="openText">Open as text</button>
  </div>
  <table id="rows"></table>
  <div class="empty" id="empty" style="display:none">No key=value pairs found.</div>
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
      const tr = document.createElement('tr');

      const kd = document.createElement('td');
      kd.className = 'key';
      kd.textContent = r.key.trim();
      tr.appendChild(kd);

      const vd = document.createElement('td');
      vd.className = 'val';
      const input = document.createElement('input');
      input.type = allRevealed ? 'text' : 'password';
      input.value = r.value;
      input.spellcheck = false;
      input.addEventListener('change', () => {
        vscode.postMessage({ type: 'edit', line: r.line, value: input.value });
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
      document.getElementById('name').textContent = m.fileName || '.env';
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
}
