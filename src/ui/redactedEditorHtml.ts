// ABOUTME: Markup, styles and browser-side script for the redacted editor.
// ABOUTME: Split from redactedEditor.ts so behaviour and presentation stay separable.

import { randomBytes } from "node:crypto";

function nonce(): string {
  return randomBytes(16).toString("base64");
}

export function redactedEditorHtml(): string {
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
  <button class="secondary" id="historyBtn">History</button>
  <button class="secondary" id="toggleAll">Reveal all</button>
  <button class="secondary" id="openText">Open as text</button>
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
    render(m.rows);
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

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
