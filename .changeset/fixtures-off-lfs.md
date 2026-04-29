---
---

Move IFC test fixtures off Git LFS onto a manifest-driven, fetch-on-demand
model. The LFS quota on `louistrue/ifc-lite` was exhausted in early 2026,
which broke `git clone` for new contributors (PR #585). After this change:

- `tests/models/` is no longer tracked in git; the canonical catalogue lives
  in `tests/models/manifest.json` (path + sha256 + size, version 1).
- `pnpm fixtures` downloads every entry from a GitHub Release, verifies
  SHA-256, and is idempotent across re-runs. Override the source with
  `IFC_LITE_FIXTURE_BASE_URL=` for mirrors or local cache servers.
- `pnpm fixtures:check` is a CI-friendly verifier that fails if any fixture
  is missing or out of date.
- `pnpm fixtures:upload` (maintainer-only, requires `gh` CLI) publishes new
  fixtures to the configured release tag.
- Tests that previously panicked on fixture absence now skip with a clear
  `pnpm fixtures` hint, including for stale Git LFS pointer files left over
  from before the migration.

See `tests/models/README.md` for the full design and migration runbook.
This change has no published-package surface area — fixtures are dev/test
infrastructure only.
