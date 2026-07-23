# CLAUDE.md

## What this is

Shush is a VS Code extension (publisher `thedevlabs-io`) that opens secret files
— `.env`, `.dev.vars`, JSON configs — in a **redacted custom editor**: keys stay
visible, values are masked as password fields until revealed. The point is that
secrets never render on screen during calls or screen shares.

## Architecture

Three source files, all in `src/`, bundled by esbuild into a single CJS file.

- **`extension.ts`** — activation and the pattern-matching orchestration layer.
  Registers the custom editor and three commands (`shush.protectActiveFile`,
  `shush.openConfig`, `shush.openAsText`). Owns the `ConfigStore` (merges
  `shush.patterns` from settings with `patterns` arrays read from each
  workspace folder's `.shushrc.json`) and the tab-swap logic.
- **`redactedEditor.ts`** — the `RedactedEnvEditorProvider`
  (`CustomTextEditorProvider`). Parses the document, renders a webview of
  key/value rows, and writes edits back via `WorkspaceEdit`. Contains the full
  webview HTML/CSS/JS inline in `html()`.
- **`glob.ts`** — a hand-rolled minimal glob matcher (`**`, `*`, `?` only) and
  `basename`. Shared so built-in and user patterns match identically. No
  external glob dependency.

### Two protection mechanisms — this is the key design distinction

1. **Built-in patterns** (`.env`, `.env.*`, `*.env`, `.dev.vars`, `.dev.vars.*`)
   are declared as the custom editor's `selector` in `package.json`. VS Code
   opens these in the redacted editor **by default, with zero flash**.
2. **User patterns** (`.shushrc.json` + `shush.patterns` setting) cannot be
   registered as a static file association at runtime — a VS Code limitation.
   Instead `extension.ts` watches open tabs (`onDidChangeTabs`) and *swaps* a
   matching plain-text tab into the redacted editor via
   `vscode.openWith`. This means a **brief flash of raw content is possible**
   for these files. Keep this trade-off in mind; it's documented in the README
   and is intentional.

`textAllowed` (a URI set) tracks files the user explicitly reopened as plain
text via `shush.openAsText`, so the swap logic leaves them alone. `inFlight`
guards against re-entrant swaps.

### Editor parsing model (`redactedEditor.ts`)

- **Format detection** by `languageId` / `.json` extension, else treated as env.
- **env:** line-based. Each `KEY=VALUE` line becomes a row with id `L<lineNumber>`;
  comments/blank lines skipped. Edits rewrite only that one line, preserving the
  original key text and separator whitespace.
- **JSON:** parsed and walked into an indented row tree (`buildRows`). Containers
  become header rows; leaves carry a dotted/bracketed path id (e.g. `a.b[0].c`)
  used to route edits. Editing re-serializes the whole document; `coerce()`
  restores the original value's type (number/boolean/null) and `detectIndent()`
  preserves the file's indentation style. Unparseable JSON is masked as one
  `__raw__` block and is **not editable**.

The webview communicates over `postMessage`: `ready`/`edit`/`openText` from the
webview, `load` (rows) from the extension. A strict CSP with a per-render nonce
guards the inline script.

## Conventions specific to this repo

- Source files start with a 2-line `ABOUTME:` comment.
- No runtime dependencies — only dev tooling (esbuild, typescript, types). Keep
  it that way; the glob matcher is deliberately in-house to avoid a dependency.
- `dist/extension.js` is the shipped artifact (referenced by `main`); rebuild
  before packaging (`vscode:prepublish` handles this).
- When changing built-in file coverage, update **both** the `customEditors`
  selector in `package.json` and the README's "Built-in patterns" list.

## User Preference
- never commit to main — always build first (`npm run build`), verify the extension works,
  then push feature branch and create a PR.
- always review changes before committing with sub agent out of the context agent for skeptical eyes.
- push back on requests that are not in the scope of the extension, or that are not aligned with the
  purpose of the extension.
- document all changes with a clear description of the change, the reason for the change,
  and the impact of the change. Maintain a changelog for all changes made to the extension.
