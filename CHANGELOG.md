# Changelog

All notable changes to Shush are documented here. This project follows
[Semantic Versioning](https://semver.org/).

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
