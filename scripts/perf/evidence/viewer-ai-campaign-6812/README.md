# Landed viewer AI campaign and follow-up qualification

This is a bundle qualification, not an end-to-end loading performance claim.
Measured source: `103c37c7f19a7d8e57681e32925d5fbab7e898d7`, retained on
`evidence/viewer-ai-campaign-6de1b059`; main base:
`3d9746da504015ce2bf6bea6e6587a5a46b239b1`.

The source includes landed P19 checkpoints, AI nodes/CLI and viewer review;
U03 workbench/report language/reset; U04 migration and native links; and both
P20 layers, including native Save-to-Flow. It also includes the U04 rejected-save
companion rollback and P20 reusable-workflow follow-up fixes (#7068 and #7071), plus the canonical fixture/first-party starter repair (#7073).
The qualification includes the final queued-prompt cleanup and a scoped native clash-review assertion.

The generated [measurement](bundle.json) and [ratchet report](bundle-check.md)
pass all existing ceilings. They use the previously approved U02 ceiling;
this qualification introduces no further ceiling or tolerance change.

Verification on this integrated source passed 95 native/mounted viewer cases,
134 Flow tests, 159 Flow-node tests and 1,334 CLI tests (15 fixture-dependent
skips), plus root typecheck covering 3,678 test sources. The current starter suite passes 113 tests. The viewer cases include
Flow review/resume/publication, real IFC Save-to-Flow save/export/reload and
permission/tracked-rerun behavior, native recipe file import, scope changes,
review navigation and sidebar migration. A later four-test native recipe-import
run additionally proves fresh graph identity even without a destination collision.

The U04 follow-up passes its production-revert oracle: 19 green baseline tests,
seven assertion failures with the two persistence files reverted together, and clean restoration.
The P20 follow-up passes its oracle: 17 green baseline tests, six assertion failures
with five changed production files reverted together, and clean restoration.
Those runs provide collective coverage rather than independent proof of every hunk.
A separate mutation disables only the actual native clash-review render path:
six green card tests become five passing and one failing while the recipe label
stays present. The canonical starter-download repair similarly passes three
baseline native/scaffold tests and produces two assertion failures when its
production template changes are reverted.
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
