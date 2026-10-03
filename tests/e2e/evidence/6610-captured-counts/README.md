# Captured manual counts — #6610 / review 4171273838

Manual summaries and groups now use the same captured derived-count formatter
as table and IDS reports. Percentages, authored literals and direct defaults
retain their previous semantics.

## Actual causal control

- Test-only source `034c823f5d36681c29ded2fb344e46389ffe23ec`:
  one raw-default case passed; German and French cases produced genuine PDF
  assertion failures for missing grouped manual counts. Zero skips/load errors.
- Minimal production fix `97fd390052120162ba4018733f864a85c0c45f89`:
  the same three controls passed. The fixture passes the real manual document
  validator, uses consistent persisted group/items counts and a real PNG, and
  retains catalogue/locale changes during asynchronous preparation.
- Current-main producer `91c9648b56507a0405c42384ddc0688cc6ff23cc` on
  main `63a7c478bf25460864dd2e809546f9678d1843e5`: six numeric/shared-PDF
  tests passed, including the committed real SketchUp sample (four walls).
  Root Turbo typecheck (111 tasks), mandatory audit (3,326 files / 57 packages),
  lint, module-size, source-test and test-wiring gates all exited zero.

German uses grouped pass/fail counts; French uses grouped warning/unanswered
counts, covering all four verdicts and group/summary pass-total text. The
uncaptured control keeps raw English manual counts despite an active German UI.
These are declared saved-document invariants, not claimed validator-engine
results. Mounted canonical-consumer controls live in the next layer.

`manual-counts-raw.tar.gz` is a lossless archive of the exact red/green logs,
source patches, current producer gate logs and source-stack identity receipt.
Archive SHA-256: `71e2d2823a6bb482dee792ae452742b3ec727f1d5136471c1d237f730b8d6cba`.

The native four-export paper-band proof under `../6610-paper-bands/` remains
qualified for source `325593c90bc85af810f7df6b09eef21222ee7fc4` only. Later
manual-format/main-integration successors do not inherit a new native run merely
through ancestry. This evidence does not claim performance qualification.
