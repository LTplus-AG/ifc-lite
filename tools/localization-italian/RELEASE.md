# Italian release preparation

Italian runtime validation and Settings-based hardware GPU acceptance have passed.
See [ACCEPTANCE.md](./ACCEPTANCE.md) for the complete acceptance criteria and
hardware report provenance. CI and merge-queue checks must still pass on the
published head before release.

## Accepted validation

- Runtime source `20fb0c3d57c1`: fleet request
  `auto-687c33fb4be044aba991f2645abb1f8e`, worker
  `9e2bc5ae-0a91-456c-b288-62cbac131384`, exit 0. All 193 selected tests passed;
  full root typecheck covered 4,648 test files across 70 packages. The
  production-revert oracle reported `OBSERVED` with restoration verified, and
  the pinned-main silent-revert guard passed.
- Hardware source `b4173c8cd1ff`: request
  `auto-447f27103597498583ba117e656839e0`, PC hardware acceptance passed all ten
  checks with zero browser errors on a non-fallback NVIDIA Blackwell adapter.
  Report: PC `/tmp/italian-acceptance-b4173c8cd1-rkn1haqe/results/workflow.json`.
  This includes the real IFC model, Italian IDS findings and parsed JSON export,
  a 390 px viewport, Settings persistence, English switching and it-CH negotiation.
- Changes after these sources affect acceptance documentation and the harness
  only: the visible phone launcher name and an explicit empty-local-Chrome
  diagnostic. Viewer runtime is unchanged. The successful hardware run includes
  the phone locator fix; remote CDP does not use the local Chrome lookup.

The original `f3acb2fb3e` Pop validation failed and its historical GPU request
`auto-fb33598fc585457e9a94b62c9bdada2e` was queued when originally inspected.
Those records retain their original source identities and must not be replayed,
removed or counted as passing evidence. They are superseded for release
qualification by the accepted runs above; their historical status is not a
release blocker. The later `20fb0c3d57` hardware attempt also remains preserved:
it failed on the retired phone launcher name, which the accepted `b417` run fixes.

## Release and reproduction

The full viewer suite runs in the merge queue; selected tests do not establish
full-monorepo, Rust or external-fixture acceptance. Select Italiano or English
in Settings → General → Language. Auto clears the saved choice; obsolete
`?lang=` overrides are ignored. French has merged. Roll back via a normal commit
as described in the i18n README.

For a fresh run, set `ITALIAN_WORKFLOW_ATTEMPT` to a new directory name.
Reports go to `evidence/<attempt>/`; an existing attempt is refused to preserve
its evidence. Without that variable, the harness generates a unique name.
