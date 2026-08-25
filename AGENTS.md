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
- **`history.ts`** — `HistoryStore`, the opt-in snapshot store. Snapshots go into
  `context.secrets` (`SecretStorage`), one JSON bucket per file keyed by a sha256
  of the URI, plus an index key so "clear all" can find every bucket. **Never
  write history to disk or into the workspace** — that would put secrets
  somewhere git can reach them, which is the whole thing this extension prevents.
  `shush.history.enabled` / `maxVersions` are `application`-scoped on purpose: a
  workspace must not be able to enable secret retention for a teammate.
- **`historyPanel.ts`** — the separate tab that shows one stored version, or a
  key-level diff of two. A webview, **never `vscode.diff`** — the built-in diff
  editor is a plain text editor and would print both versions of every secret.
  One panel per file, reused; `closeAll()` runs on any purge so a tab can't
  outlive the data behind it.
- **`diff.ts`** — pure key-level comparison (`added`/`removed`/`changed`/
  `unchanged`), keyed by env name or JSON path.
- **`model.ts`** — pure helpers (env key validation, value sanitising, snapshot
  id/pruning) with no `vscode` import, so `npm test` can bundle and run them
  under `node:test`.
- **`search.ts`** — the find bar's row filter (`filterRows`): matches a query
  against keys, values or both, keeps a matching leaf's ancestor containers and a
  matching container's subtree. Pure and `vscode`-free so it is unit-tested, and
  the webview embeds `filterRows.toString()` instead of holding a second copy —
  which is why the function must stay self-contained (no imports, no outside
  references) and why `html()` binds it to a `const` (the minified build renames
  the declaration).
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

Find (`Cmd/Ctrl+F`) filters entirely inside the webview — the rows are already
there, and matching a value never posts it back or unmasks it. Only the key name
is highlighted; the value stays a password field. Scope and case sensitivity are
kept in the webview's own `setState`.

Adding a value uses VS Code input boxes rather than webview fields so the value
prompt can be `password: true`. Env values are run through `sanitizeEnvValue` on
both edit and add — a raw newline would otherwise inject extra variables.

The webview communicates over `postMessage`: `ready`/`edit`/`openText`/`add`/
`versions`/`showVersion`/`restoreVersion`/`clearHistory` from the webview,
`load` (rows), `versions` (timestamps only, never content) and `versionRows`
from the extension. Historical versions render through the same masking path as
the live file — never as plaintext or a diff. A strict CSP with a per-render nonce
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
