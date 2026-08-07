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
- **+ Add value** — add a new variable without leaving the redacted editor.
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

## Adding values

**+ Add value** in the editor toolbar asks for the name, then the value — and the
value prompt is a password field, so a new secret never renders on screen either.

- **env** — appends `KEY=VALUE`. Names must look like env keys and must not
  already exist in the file; newlines in a value are collapsed so a pasted value
  can't inject extra variables.
- **JSON** — pick the object or array to add to, then the key. Arrays append (no
  key needed). Existing keys are refused rather than overwritten.

> **JSON caveat:** editing or adding in a JSON file re-serialises the whole
> document, so original formatting is normalised and integers beyond 2⁵³ lose
> precision. Both were true of editing before this release; open such a file as
> text if that matters.

## Version history (off by default)

Turn on `shush.history.enabled` and Shush keeps a snapshot of each protected file
every time you save it, so you can look back at what a value used to be. The
**History** button in the toolbar (pinned to the top of the editor, so it stays
reachable however far down the file you are) lists versions, each with two
actions:

- **Diff** — a **key-level diff in its own tab**: which keys were added, removed
  or changed between that version and the current file, both values side by
  side. Values stay masked; reveal them one at a time or all at once. Unchanged
  keys are hidden until you ask for them.
- **Restore** — opens that same diff *first*, so you see exactly what would
  change, then confirms. The current contents are snapshotted before the write,
  so a restore is itself reversible.

The diff tab drives everything from two dropdowns:

```
From [ 7 Aug 09:14 ▾ ]  →  To [ current file ▾ ]   ⇄ Swap   Restore the "From" version
```

Either side can be any stored version or the current file, so you can compare
any two points without going back to the list — **added** always means *present
in To, absent in From*. Set **From** to *"— nothing"* to show a single version on
its own. Changing either side re-masks every value.

> **Why not VS Code's diff editor?** It's a plain text editor, so diffing two
> `.env` versions would render every secret — old *and* new — in the clear, in a
> tab that's easy to leave open on a call. A key-level diff is also the more
> useful unit for a secrets file: you want to know *which keys changed*, not
> which lines moved.

This is a copy of your secrets that outlives the file, so it's built to fail safe:

- **Off unless you turn it on**, and the setting is **user-scoped only**
  (`"scope": "application"`) — a committed `.vscode/settings.json` cannot switch
  it on for a teammate. The first time you enable it, Shush tells you where the
  data goes and offers to turn it back off.
- **Never written to the workspace or any file Shush controls.** Snapshots live
  in VS Code's `SecretStorage`, so there is nothing for git to pick up.
- Keeps the last `shush.history.maxVersions` (default 10) per file, skips files
  over 256 KB, and only ever snapshots files you've actually opened in the
  redacted editor.
- Turning history back off asks whether to delete what it already collected, and
  **Shush: Delete all stored version history** purges everything at any time.
- If the credential store can't be written, Shush warns you rather than silently
  keeping nothing.

### Where snapshots are stored, per platform

`SecretStorage` is VS Code's own secret store, and its strength depends on the OS:

| Platform | Backing store |
|---|---|
| macOS | Keychain |
| Windows | Credential Manager (DPAPI, tied to your Windows account) |
| Linux | gnome-keyring / KWallet via libsecret |

On Linux **without** a keyring available (some minimal desktops, WSL, containers,
SSH sessions), VS Code falls back to a weaker local encryption store — the key
sits next to the data, so it stops anyone casually reading the file and not much
more. On any platform the data is readable by code already running as you. If
that's not a trade you want, leave history off; the rest of Shush is unaffected.

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
