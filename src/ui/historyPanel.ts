// ABOUTME: A separate tab showing a stored version, or a key-level diff between two versions.
// ABOUTME: Deliberately a webview, not VS Code's diff editor — that would render every secret as plain text.

import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { describe, summarize, type DiffRow } from "../core/diff";

/** A choice in the Old/New dropdowns. `value` is "none", "current", or a timestamp. */
export interface VersionOption {
  value: string;
  label: string;
}

export interface PanelContent {
  /** File name shown in the header. */
  fileName: string;
  /** What the two sides are, e.g. "2 Aug 14:03" → "current file". */
  beforeLabel: string;
  afterLabel: string;
  /** True when only one version is being shown, so the panel drops the before column. */
  single: boolean;
  rows: DiffRow[];
  /** Everything selectable, newest first, for both dropdowns. */
  options: VersionOption[];
  /** Current selections, matching `VersionOption.value`. */
  before: string;
  after: string;
}

export interface PanelHandlers {
  /** Repick either side. Values match `VersionOption.value`. */
  onSelect(before: string, after: string): void;
  /** Restore the version currently on the Old side. */
  onRestore(at: number): void;
}

/**
 * One panel per file, reused. Opening a second version for the same file
 * replaces the contents rather than stacking tabs full of secrets.
 */
export class HistoryPanel {
  private static readonly panels = new Map<string, vscode.WebviewPanel>();
  private static readonly handlers = new Map<string, PanelHandlers>();

  static show(key: string, content: PanelContent, handlers: PanelHandlers): void {
    const title = content.single
      ? `${content.fileName} @ ${content.afterLabel}`
      : `${content.fileName} — changes`;

    let panel = HistoryPanel.panels.get(key);
    if (panel) {
      panel.title = title;
      panel.reveal(panel.viewColumn, true);
    } else {
      panel = vscode.window.createWebviewPanel(
        "shush.historyView",
        title,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        { enableScripts: true, retainContextWhenHidden: false }
      );
      HistoryPanel.panels.set(key, panel);
      panel.onDidDispose(() => HistoryPanel.panels.delete(key));
      // Registered once, but reads the handler from the map on each message so a
      // later show() can swap in a fresh closure.
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        if (raw === null || typeof raw !== "object") {
          return;
        }
        const msg = raw as { type?: unknown; before?: unknown; after?: unknown; at?: unknown };
        const current = HistoryPanel.handlers.get(key);
        if (msg.type === "select") {
          current?.onSelect(String(msg.before), String(msg.after));
        } else if (msg.type === "restore") {
          current?.onRestore(Number(msg.at));
        }
      });
    }
    HistoryPanel.handlers.set(key, handlers);

    // Re-rendering wholesale also re-masks every value.
    panel.webview.html = HistoryPanel.html(content);
  }

  /** Close every open history tab — used when history is purged or switched off. */
  static closeAll(): void {
    for (const panel of [...HistoryPanel.panels.values()]) {
      panel.dispose();
    }
    HistoryPanel.panels.clear();
    HistoryPanel.handlers.clear();
  }

  private static html(content: PanelContent): string {
    const nonce = randomBytes(16).toString("base64");
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    // Values reach the page as JSON in a script block, never interpolated into markup.
    const data = JSON.stringify(content).replace(/</g, "\\u003c");
    const summary = describe(summarize(content.rows));

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); margin: 0; }
  .bar { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 10px;
         padding: 10px 14px; background: var(--vscode-editor-background);
         border-bottom: 1px solid var(--vscode-panel-border); }
  .bar .name { font-weight: 600; }
  .bar .summary { margin-right: auto; opacity: .75; font-size: 12px; }
  button { font: inherit; color: var(--vscode-button-secondaryForeground);
           background: var(--vscode-button-secondaryBackground); border: none;
           padding: 4px 10px; border-radius: 4px; cursor: pointer; }
  button:hover { opacity: .9; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
       opacity: .6; padding: 8px 14px; border-bottom: 1px solid var(--vscode-panel-border); }
  td { padding: 6px 14px; border-bottom: 1px solid var(--vscode-panel-border);
       vertical-align: middle; font-family: var(--vscode-editor-font-family); font-size: 13px; }
  td.key { white-space: nowrap; color: var(--vscode-symbolIcon-variableForeground); }
  td.val { width: 45%; }
  .mask { display: inline-flex; align-items: center; gap: 6px; width: 100%; }
  .mask code { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .none { opacity: .4; font-style: italic; }
  .tag { font-size: 11px; padding: 1px 6px; border-radius: 3px; text-transform: uppercase;
         letter-spacing: .04em; }
  .added   .tag { background: var(--vscode-gitDecoration-addedResourceForeground, #2ea043); color: #fff; }
  .removed .tag { background: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); color: #fff; }
  .changed .tag { background: var(--vscode-gitDecoration-modifiedResourceForeground, #d29922); color: #000; }
  tr.unchanged { opacity: .55; }
  .eye { background: transparent; color: var(--vscode-foreground); opacity: .65; padding: 2px 4px;
         display: inline-flex; }
  .eye:hover { opacity: 1; }
  .empty { padding: 24px 14px; opacity: .7; }
  .picker { display: flex; align-items: center; gap: 8px; padding: 8px 14px; font-size: 12px;
            border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
  .picker label { opacity: .7; text-transform: uppercase; letter-spacing: .04em; font-size: 11px; }
  .picker select { font: inherit; color: var(--vscode-dropdown-foreground);
                   background: var(--vscode-dropdown-background);
                   border: 1px solid var(--vscode-dropdown-border, transparent);
                   border-radius: 4px; padding: 3px 6px; }
  .picker .arrow { opacity: .6; }
  .picker .swap { margin-left: 4px; }
  .picker .restore { margin-left: auto; color: var(--vscode-button-foreground);
                     background: var(--vscode-button-background); }
</style>
</head>
<body>
  <div class="bar">
    <span class="name" id="name"></span>
    <span class="summary" id="summary"></span>
    <button id="toggleUnchanged"></button>
    <button id="revealAll">Reveal all</button>
  </div>
  <div class="picker">
    <label for="before">From</label>
    <select id="before"></select>
    <span class="arrow">→</span>
    <label for="after">To</label>
    <select id="after"></select>
    <button class="swap" id="swap" title="Swap the two sides">⇄ Swap</button>
    <button class="restore" id="restore">Restore the “From” version</button>
  </div>
  <table id="table"></table>
  <div class="empty" id="empty" style="display:none"></div>
<script nonce="${nonce}" type="application/json" id="payload">${data}</script>
<script nonce="${nonce}">
  const content = JSON.parse(document.getElementById('payload').textContent);
  const SUMMARY = ${JSON.stringify(summary)};
  let revealed = false;
  let showUnchanged = false;

  const EYE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function dots(n) { return '•'.repeat(Math.min(Math.max(n, 6), 24)); }

  /** A value cell: masked until its own eye is clicked. */
  function valueCell(value) {
    const td = document.createElement('td');
    td.className = 'val';
    if (value === undefined || value === null) {
      const em = document.createElement('span');
      em.className = 'none';
      em.textContent = '—';
      td.appendChild(em);
      return td;
    }
    const wrap = document.createElement('span');
    wrap.className = 'mask';
    const code = document.createElement('code');
    let shown = revealed;
    const paint = () => { code.textContent = shown ? value : dots(value.length); };
    paint();
    const eye = document.createElement('button');
    eye.className = 'eye';
    eye.title = 'Show / hide this value';
    eye.innerHTML = shown ? EYE_OFF : EYE;
    eye.addEventListener('click', () => {
      shown = !shown;
      paint();
      eye.innerHTML = shown ? EYE_OFF : EYE;
    });
    wrap.appendChild(code);
    wrap.appendChild(eye);
    td.appendChild(wrap);
    return td;
  }

  function render() {
    const table = document.getElementById('table');
    table.innerHTML = '';
    const rows = content.rows.filter(r => showUnchanged || r.kind !== 'unchanged');

    const empty = document.getElementById('empty');
    if (!rows.length) {
      empty.style.display = 'block';
      empty.textContent = content.rows.length
        ? 'Nothing changed between these versions.'
        : 'This version has no values.';
      return;
    }
    empty.style.display = 'none';

    const head = document.createElement('tr');
    for (const label of content.single ? ['Key', content.afterLabel]
                                       : ['Key', '', content.beforeLabel, content.afterLabel]) {
      const th = document.createElement('th');
      th.textContent = label;
      head.appendChild(th);
    }
    table.appendChild(head);

    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.className = r.kind;

      const key = document.createElement('td');
      key.className = 'key';
      key.textContent = r.key;
      tr.appendChild(key);

      if (!content.single) {
        const tag = document.createElement('td');
        if (r.kind !== 'unchanged') {
          const span = document.createElement('span');
          span.className = 'tag';
          span.textContent = r.kind;
          tag.appendChild(span);
        }
        tr.appendChild(tag);
        tr.appendChild(valueCell(r.before));
      }
      tr.appendChild(valueCell(r.after));
      table.appendChild(tr);
    }
  }

  function paintToggle() {
    document.getElementById('toggleUnchanged').textContent =
      showUnchanged ? 'Hide unchanged' : 'Show unchanged';
  }

  const api = acquireVsCodeApi();

  function fillPicker(id, selected, includeNone) {
    const select = document.getElementById(id);
    select.innerHTML = '';
    for (const opt of content.options) {
      if (opt.value === 'none' && !includeNone) { continue; }
      const el = document.createElement('option');
      el.value = opt.value;
      el.textContent = opt.label;
      if (opt.value === selected) { el.selected = true; }
      select.appendChild(el);
    }
    select.addEventListener('change', () => {
      api.postMessage({
        type: 'select',
        before: document.getElementById('before').value,
        after: document.getElementById('after').value,
      });
    });
  }

  // Only "From" may be "none" — that is what turns the diff into a single-version view.
  fillPicker('before', content.before, true);
  fillPicker('after', content.after, false);

  const restorable = /^\\d+$/.test(content.before) ? content.before : null;
  const restoreBtn = document.getElementById('restore');
  restoreBtn.style.display = restorable ? '' : 'none';
  restoreBtn.addEventListener('click', () => {
    if (restorable) { api.postMessage({ type: 'restore', at: Number(restorable) }); }
  });

  document.getElementById('swap').addEventListener('click', () => {
    const before = document.getElementById('before').value;
    const after = document.getElementById('after').value;
    if (before === 'none') { return; }
    api.postMessage({ type: 'select', before: after, after: before });
  });

  document.getElementById('name').textContent = content.single
    ? content.fileName + ' @ ' + content.afterLabel
    : content.fileName + ':  ' + content.beforeLabel + '  →  ' + content.afterLabel;
  document.getElementById('summary').textContent = content.single ? '' : SUMMARY;
  document.getElementById('toggleUnchanged').style.display = content.single ? 'none' : '';
  document.getElementById('swap').style.display = content.single ? 'none' : '';
  paintToggle();

  document.getElementById('revealAll').addEventListener('click', () => {
    revealed = !revealed;
    document.getElementById('revealAll').textContent = revealed ? 'Hide all' : 'Reveal all';
    render();
  });
  document.getElementById('toggleUnchanged').addEventListener('click', () => {
    showUnchanged = !showUnchanged;
    paintToggle();
    render();
  });

  render();
</script>
</body>
</html>`;
  }
}
