# Block .env Expose

A VS Code extension that keeps `.env` (and similar) files hidden behind a
confirmation gate, so their contents never flash on screen when you open them by
accident during a call, screen share, or with someone sitting next to you.

## How it works

When a protected file's tab opens, the extension **immediately closes it** —
before the contents can render — and shows a modal:

> "*.env* may contain secrets. Reveal it?"

Only when you click **Reveal** does the file reopen and show its contents. If you
dismiss the modal, the file stays closed. Once you close a revealed file it is
re-locked, so the next time it opens you're prompted again.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `blockEnvExpose.enabled` | `true` | Turn the guard on/off. |
| `blockEnvExpose.patterns` | `["**/.env", "**/.env.*", "**/*.env"]` | Globs for files to protect. |
| `blockEnvExpose.relockOnClose` | `true` | Re-lock a file after its editor closes. |

## Commands

- **Block .env: Re-lock all protected files** — forget approvals and close any
  open protected files (use this right before you start sharing your screen).
- **Block .env: Reveal the active protected file** — mark the current file as
  approved without a prompt.

## Develop / run locally

```bash
npm install
npm run build      # bundle to dist/extension.js
```

Then press **F5** in VS Code to launch an Extension Development Host, open any
`.env` file, and watch it get gated.

## Package as a `.vsix`

```bash
npx @vscode/vsce package
```

Install the resulting `.vsix` via the Extensions view → `…` → *Install from
VSIX…*.

## Limitations

The guard reacts to the tab-open event and closes the tab as fast as possible.
There is a fraction of a second where VS Code may paint the editor before the
close lands. For a hard guarantee, also re-lock (`Block .env: Re-lock all`)
before you begin sharing.
