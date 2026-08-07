# Changelog

All notable changes to Shush are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-08-07

### Added

- **Add new values from the redacted editor.** A `+ Add value` button in the
  toolbar prompts for a name and then a value; env files get a new `KEY=VALUE`
  line, JSON files let you pick the object/array to insert into.
  - **Why:** the editor could only change values that already existed, so adding
    a variable meant reopening the file as plain text — exactly the exposure the
    extension exists to avoid.
  - The value prompt uses a password input box, so a new secret is never
    rendered on screen. Env names are validated and rejected if they duplicate an
    existing key or wouldn't parse back out of the file.
  - **Impact:** additive. No change to how existing files are parsed or shown.

- **Opt-in version history for protected files** (`shush.history.enabled`,
  default `false`). Snapshots are taken on save; the toolbar `History` button
  lists versions, views one **masked in the redacted editor**, or restores it
  behind a confirmation. New command **Shush: Delete all stored version history**;
  `shush.history.maxVersions` (default 10) caps retention.
  - **Why:** requested so a value can be recovered after an overwrite, without
    putting secrets in git.
  - **Security posture:** snapshots live in VS Code `SecretStorage` (OS
    credential store) — never in the workspace, so they can't be committed. Both
    settings are `application`-scoped, so a committed `.vscode/settings.json`
    cannot enable history for a teammate. Enabling it shows a one-time modal
    stating where the data lives, including the weaker Linux-without-keyring
    fallback, with an option to back out. Files over 256 KB are skipped, and only
    files opened in the redacted editor are ever snapshotted.
  - **Impact:** nothing is stored and no behaviour changes unless a user turns it
    on themselves.

### Fixed

- **Newlines in an edited env value no longer inject extra lines.** Saving a
  value containing a newline previously wrote it verbatim, silently adding
  variables to the file; newlines (and bare `\r`) are now collapsed to spaces.
- **JSON edits through `__proto__` / `constructor` / `prototype` paths are
  refused** instead of being silently dropped by the engine, which lost the edit
  with no feedback.
- **CSP nonce now comes from `crypto.randomBytes`** rather than `Math.random()`.

### Security hardening (from review of this release)

- Index writes are serialised, and the index entry is written before the
  snapshot, so two files saved in the same tick can't orphan a bucket of secrets
  that "Delete all" would then be unable to find. `clearAll` additionally sweeps
  every file currently open in the redacted editor.
- Retention is enforced on **read**: lowering `maxVersions` drops the excess
  snapshots immediately instead of waiting for the next save of that file.
- Snapshot failures (locked keychain, no Linux keyring) and skipped oversized
  files now warn once per file — history never fails silently while the user
  believes it's on.
- Adding a key that already exists is refused for JSON as well as env, so a
  secret can't be overwritten by an add; `export FOO=` counts as `FOO` when
  checking for duplicates.

### Internal

- New `src/model.ts` (pure helpers) and `src/history.ts` (snapshot store).
  `npm test` runs a `node:test` suite over the pure logic — no new runtime
  dependencies.

## [0.2.3] — 2026-07-23

### Packaging

- **Added a `.vscodeignore`** so the published `.vsix` ships only what a
  consumer needs (`dist/`, `media/`, README, LICENSE, changelog, manifest).
  - **Why:** without it, `vsce` bundled internal files — `AGENTS.md`,
    `CLAUDE.md`, `.claude/` agent memory, and the internal `docs/PUBLISHING.md`
    — into the package. Cut the `.vsix` from 14 files to 9.
- **Declared `@vscode/vsce` as a devDependency.** The `package` script called
  `vsce` but it was never a dependency, so `npm run package` failed with
  `vsce: command not found` on a clean install.
- **Ignore `.claude/` in git** — local agent tooling config/memory, not source.
- **Impact:** packaging/tooling only. No runtime, settings, or behavior change.

## [0.2.2] — 2026-07-23

### Changed

- **New logo.** Replaced the old padlock-with-`.env` mark (leftover "Block .env
  Expose" branding) with a `sh…` wordmark — the product name trailing off into
  the masked dots the editor renders.
  - **Why:** the previous icon was `.env`-specific and carried the pre-rebrand
    name, underselling an extension that now also redacts JSON and `.dev.vars`.
  - Adopts the [thedevlabs.io](https://thedevlabs.io) brand palette: orange
    `#f47c20 → #d9660c` on near-black `#0e0e10`, set in IBM Plex Mono (the
    brand's code font).
  - **Impact:** cosmetic only — `media/logo.svg` and `media/icon.png` updated;
    no behavior, settings, or file-matching changes.
