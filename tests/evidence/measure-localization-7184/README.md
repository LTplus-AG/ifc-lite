# Measure localization regressions (#7184)

Current quantity labels and complete key accounting are verified through the mounted Measure panel and an actual parsed IFC4 invariant: two selected walls, one authored NetSideArea of 12 m². The test checks the displayed 12 m² row, contributor coverage 1/2, Partial state and a live locale switch. It removes an orphan catalogue entry without changing quantity behavior.

The exact main4b two-file baseline reproduces both stale assertions (15 passing, two failing); finally restoring the corrected files gives 18 passing, zero skipped. Plain root typecheck covers 3,739 test files across 62 packages. All six scoped gates pass. `qualification.json` records commands, authoritative handles, scopes and hashes. `archive-index.json` maps original artifacts to compressed bytes without executable duplicate source files.

Runtime preparation copied existing artifacts from an identical Rust tree. Turbo restored a different runtime for the actual tests, and strict typecheck later restored another artifact. These phases are recorded separately. This is no fresh Rust build, performance measurement, authored-tool fidelity or completed-scene claim. Missing WASM explicitly skips the authored fixture and its dependent accounting rather than claiming coverage.

The historical first correction failed its own combined-label audit and remains excluded from final qualification. Publication, eventual main integration, independent review and current-head required CI are separate steps.
