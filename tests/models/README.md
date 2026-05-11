# Test fixtures

This directory holds the IFC / IFCX models used by tests, examples,
benchmarks, and helper scripts. The files themselves are **not stored in
this repository** — they are fetched on demand from a GitHub Release.

The catalogue lives in `manifest.json` (committed). For each fixture it
records:

- relative path under `tests/models/`,
- SHA-256 of the file contents,
- size in bytes.

## Quick start

```sh
# After cloning, populate the fixtures (one-off; idempotent on re-runs)
pnpm fixtures

# Verify in CI without downloading anything
pnpm fixtures:check

# Show paths that are missing or out of date (one per line)
pnpm fixtures:list-missing
```

Each fetched file is verified against the manifest's SHA-256 before being
written. The fetcher is parallel (default 6 concurrent connections; override
with `FIXTURE_CONCURRENCY=N`) and uses streaming writes, so big fixtures don't
buffer in memory.

## Why not Git LFS?

LFS is bandwidth-metered; the project's quota was exhausted in early 2026,
which broke `git clone` for new contributors (see PR #585). GitHub Releases
have no per-file bandwidth budget and a 2 GB per-asset limit — comfortably
larger than the biggest fixture in the manifest. Removing LFS also drops the
client-side LFS dependency and lets us version the catalogue (`manifest.json`)
in plain git.

## Where the bytes live

By default the fetcher reads from
`https://github.com/louistrue/ifc-lite/releases/download/<release_tag>`,
where `<release_tag>` is taken from `manifest.json` (currently
`fixtures-v1`). Each asset on the release is named by its SHA-256 hash with
no extension, so the URL pattern is `<base_url>/<sha256>`.

Override the source for mirrors or local cache servers:

```sh
IFC_LITE_FIXTURE_BASE_URL=https://my-mirror.example/path pnpm fixtures
```

## For maintainers: adding a new fixture

1. Drop the file under `tests/models/<group>/<name>` locally.
2. Regenerate the manifest:
   ```sh
   pnpm fixtures:manifest
   ```
3. Upload the new asset to the release (requires the `gh` CLI logged in
   with write access to `louistrue/ifc-lite`):
   ```sh
   pnpm fixtures:upload
   ```
   `upload-fixtures.mjs` checks every local file against the manifest before
   uploading and skips assets that are already on the release. It will also
   create the release if it doesn't exist yet.
4. Commit the updated `manifest.json`.

## For maintainers: rotating to a new release

1. Bump `release_tag` in `manifest.json` (e.g. `fixtures-v1` → `fixtures-v2`).
2. Run `pnpm fixtures:upload` — it will create the new release and copy
   every asset over.
3. Open a PR with the bumped manifest. Old releases can be left in place; the
   manifest decides which one is canonical.

## What gets fetched, what gets skipped

The fetcher hashes any file already on disk before deciding to download. If
the on-disk file matches the manifest's `sha256`, it's left alone. This means:

- Re-running `pnpm fixtures` is cheap (no redundant downloads).
- A dev who has the files locally from a previous LFS clone keeps them
  unchanged.
- A corrupt / partial file is detected by hash and re-fetched.

`tests/models/local/` is explicitly **never** managed by the manifest — it's
reserved for private fixtures contributors keep on their own machine.
