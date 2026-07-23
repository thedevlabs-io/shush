# Shush

<img src="media/icon.png" width="96" align="right" alt="Shush logo" />

A [thedevlabs-io](https://github.com/thedevlabs-io) VS Code extension that opens
secret files — `.env`, Cloudflare `.dev.vars`, JSON configs like `firebase.json`
— in a **redacted editor**: keys stay visible, values are masked as `••••••••`
until you choose to reveal them. Secrets never render on screen, so an accidental
open during a call, screen share, or with someone next to you leaks nothing.

## How it works

Shush registers a *custom editor* and makes it the default for its built-in
patterns, so VS Code hands the file to the extension instead of the plain text
editor — there's no flash of the raw file. You see:

```
API_KEY        ••••••••••••••  👁
DATABASE_URL   ••••••••••••••  👁
```

- **👁 per row** — reveal/hide a single value.
- **Reveal all / Hide all** — toggle every value at once.
- **Open as text** — reopen in the normal text editor when you need to.

Values are editable in place; edits are written back to the file. JSON files are
parsed and every leaf value is masked under its key path (e.g.
`hosting.public`). Env comment (`#`) and blank lines are ignored.

## Built-in patterns

`**/.env`, `**/.env.*`, `**/*.env`, `**/.dev.vars`, `**/.dev.vars.*`

These open redacted **by default**, with no flash.

## Adding your own files

Some teams keep secrets in other files (`firebase.json`, `*.secrets.json`, …).
Add them two ways:

1. **Command palette** → **Shush: Protect this file (add to .shushrc.json)** while
   the file is open. It writes the pattern to a project config file you commit.
2. **Settings** → `shush.patterns` (array of globs). Workspace or user scoped.

### `.shushrc.json` — shared, committed config

```json
{
  "patterns": ["**/firebase.json", "**/*.secrets.json"]
}
```

Commit this to the repo. When a teammate opens the project, Shush reads it on
startup (and watches it for changes) and protects those files automatically.

> **Note:** built-in patterns open with zero flash. Files added via
> `.shushrc.json` / settings are *swapped* into the redacted editor when opened,
> so there is a brief moment where VS Code may paint the raw file before the swap.
> This is a VS Code limitation — custom-editor file associations can't be changed
> at runtime. Keep true secrets in `.env` / `.dev.vars` where possible.

## Develop / run locally

```bash
npm install
npm run build      # bundle to dist/extension.js
```

Press **F5** to launch an Extension Development Host.

## Package & install

```bash
npm run package    # produces shush-<version>.vsix
code --install-extension shush-0.2.0.vsix
```

Or Extensions view → `…` → **Install from VSIX…**.

## License

MIT © thedevlabs-io
