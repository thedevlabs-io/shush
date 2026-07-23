# Block .env Expose

A VS Code extension that opens `.env` (and similar) files in a **redacted editor**:
keys stay visible, but every value is masked as `••••••••` until you choose to
reveal it. Secrets never render on screen — so an accidental open during a call,
screen share, or with someone next to you won't leak anything.

## How it works

The extension registers a *custom editor* and makes it the **default** for env
files. Because VS Code hands the file to the extension instead of the normal text
editor, the raw values are never painted — there's no flash. You see:

```
API_KEY        ••••••••••••••  👁
DATABASE_URL   ••••••••••••••  👁
```

- **👁 per row** — reveal/hide that single value.
- **Reveal all / Hide all** — toggle every value at once.
- **Open as text** — reopen the file in the normal text editor when you actually
  need to edit it as plain text.

Values are editable in place: type into a field and the change is written back to
the file. Comment (`#`) and blank lines are ignored.

Protected file patterns: `**/.env`, `**/.env.*`, `**/*.env`.

## Develop / run locally

```bash
npm install
npm run build      # bundle to dist/extension.js
```

Then press **F5** to launch an Extension Development Host, open any `.env` file,
and it opens redacted.

## Package & install

```bash
npm run package    # produces block-env-expose-<version>.vsix
```

Install via the Extensions view → `…` → **Install from VSIX…**, or:

```bash
code --install-extension block-env-expose-0.1.0.vsix
```

## Reopening as plain text

To bypass redaction for a file, right-click it → **Open With…** → **Text
Editor**, or use the **Open as text** button in the redacted editor.
