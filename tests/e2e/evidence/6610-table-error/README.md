# Visible failed-table messages — #6610 / review4171410340

An explicitly empty or whitespace-only translated error label could hide a
failed table's warning. The shared error-message formatter now falls back to
canonical English when both engine text and the captured translation are blank.
The existing preview consumes that formatter until the canonical-preview layer
removes it. Nonblank translated and engine errors retain their existing meaning.

- Test-only source `128f141ba4c074a6b01337df426d8a325e3bb947`:
  three existing public-model PDF controls passed; the new control genuinely
  failed because the mounted warning was absent. Zero skips/load errors.
  The new PDF subcontrol was **unrun** after its first mounted assertion failed.
- Minimal fix `b260e2407c7d543921393d54acba9b4ed2a229d6` on main
  `63a7c478bf25460864dd2e809546f9678d1843e5`: all seven selected controls
  passed. Each of four new cases inspected mounted paper and actual PDF bytes:
  empty/whitespace labels with blank engine text, and preserved nonblank
  translated/engine errors. The committed real SketchUp sample and PNG remain
  part of the actual parser/export path; no PDF or error-result mock is used.

Root Turbo typecheck (111 tasks), mandatory audit (3,326 files / 57 packages),
lint, module-size, source-test and test-wiring gates passed. The exact root
`pnpm typecheck` wrapper also passed both Turbo and mandatory audit unchanged.
Raw warnings remain in the logs. No unhandled XHR/load-error event appeared in
these selected runs; this is correctness evidence without a performance claim.

`raw-red-green.tar.gz` retains source patches, exact classified red/green logs,
all gate receipts and canonical Rust/WASM input identity.
SHA-256: `c288eccd406a239f29a65f243bf189134968a7007f0ccef722141476bf81954c`.

This receipt qualifies the producer successor and existing live preview only.
The canonical B/C/D source merge and its runtime checks remain separate. The
four-export native proof in `../6610-paper-bands/` stays scoped to source325.
