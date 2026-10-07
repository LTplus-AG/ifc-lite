# Landed viewer AI campaign and follow-up qualification

This is a bundle qualification, not an end-to-end loading performance claim.
Measured source: `28feb5b1e432e3e6de504929fda7397011fc4a85`, retained on
`evidence/viewer-ai-campaign-6de1b059`; main base:
`35f4b93f050759fce9d198ae689561c0ca9cd02d`.

The source includes landed P19 checkpoints, AI nodes/CLI and viewer review;
U03 workbench/report language/reset; U04 migration and native links; and both
P20 layers, including native Save-to-Flow. It also includes the U04 rejected-save
companion rollback and P20 reusable-workflow follow-up fixes (#7068 and #7071).
Later fresh-identity regression assertions change no measured production code.

The generated [measurement](bundle.json) and [ratchet report](bundle-check.md)
pass all existing ceilings. They use the previously approved U02 ceiling;
this qualification introduces no further ceiling or tolerance change.

Verification on this integrated source passed 84 native/mounted viewer cases,
134 Flow tests, 159 Flow-node tests and 1,334 CLI tests (15 fixture-dependent
skips), plus root typecheck covering 3,677 test sources. The viewer cases include
Flow review/resume/publication, real IFC Save-to-Flow save/export/reload and
permission/tracked-rerun behavior, native recipe file import, scope changes,
review navigation and sidebar migration. A later four-test native recipe-import
run additionally proves fresh graph identity even without a destination collision.

The U04 follow-up passes its production-revert oracle: 10 green baseline tests,
two assertion failures with the persistence change reverted, and clean restoration.
The P20 follow-up passes its oracle: 17 green baseline tests, six assertion failures
with five changed production files reverted together, and clean restoration.
The latter is collective coverage rather than independent proof of every hunk.
Individual PRs still require exact-head CI before merging. Provider quality,
coordinator study and human privacy acceptance remain open under #6928/#6812.

Reproduce the measurement against its source commit:

```sh
pnpm build:e2e
node scripts/perf-ratchet/measure-bundle.mjs --out /tmp/campaign-bundle.json
node scripts/perf-ratchet/perf-ratchet.mjs check --measured /tmp/campaign-bundle.json
```

This snapshot changes TypeScript/UI behavior. The existing WASM artifact comes
from unchanged Rust source; local compressed WASM sizes can differ from CI as
documented in the performance guide. Raw viewer bytes carry the bundle verdict.
