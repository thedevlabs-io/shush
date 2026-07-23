# Changelog

All notable changes to Shush are documented here. This project follows
[Semantic Versioning](https://semver.org/).

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
