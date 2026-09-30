# Explicit validation report saving (#6568)

The screenshots and persisted history come from the real viewer in its own T3
browser tab. [runtime-sources.json](./runtime-sources.json) records the source
hashes of the Save implementation used in that run, based on main
`1b1ea389250d7f0437ae522f0bad893b2c362eed`. No validation engine, report result,
history writer or rendered UI was replaced.

The committed public input is
`apps/viewer/public/samples/building-architecture.ifc`, exported by SketchUp
2024 (24.0.594) with IFC-manager 5.3.3. Its SHA-256 is
`3ff9b10bd00c7b96dded51e7ca5a6b69efbea38b049adcdd05fcd247de7e70d5`.
The bundled `building-architecture.ids` has SHA-256
`947159b9b1a709ebb178c00a3803dcdb74070608d8df4f99065e889d3c189652`.
Its existing authoring audit reports one error; the viewer explicitly runs
its requirements as written. This change preserves that audit and the actual
result: 11 checks, 8 passed, 3 failed.

## Reproduce

1. In a fresh browser origin, choose **Load demo project**, then **Data
   validation → IDS validation → Try with demo data → Run Validation**.
   [ids-unsaved.png](./ids-unsaved.png) shows completed results, **Saved
   reports (0)** and an enabled **Save report**. The history storage key is
   absent, as recorded in [browser-observations.json](./browser-observations.json).
2. Choose **Save report**. [ids-saved.png](./ids-saved.png) shows **Saved
   reports (1)** and disabled **Report saved**. Choose **Re-run**: history
   still contains the identical first snapshot, with a new Save control.
   Save this later result explicitly to create the second entry.
3. Switch to **Information validation** and open
   [wall-names.rules.json](./wall-names.rules.json). Run its actual uniqueness
   rule over the same model. [information-unsaved.png](./information-unsaved.png)
   shows 4 checked, 4 passed, 0 failed and **Saved reports (2)**. Choosing Save
   creates the third entry, with `sourceKind: "rules"`.

[saved-history.json](./saved-history.json) is the actual browser storage value
after those three explicit saves. Each entry includes its original model name
and source fingerprint. All three screenshots were visually inspected.

## Validation

Plain root `pnpm typecheck` passed 109 tasks, covering all 3,161 test files at
the initial implementation base. Root Turbo mounted viewer tests passed 22
saved-report cases, 8 information-panel cases, 1 real concurrent-run case and
4 real cancellation/clear cases, with zero skips. They cover completion-time
provenance after a model rename and report mutation, panel remount, duplicate
clicks, actual storage refusal/retry, and discarded in-flight results.

Reintroducing the old autosave calls makes 2 IDS cases fail (20 pass) and the
information run case fail (7 pass). Both hooks were restored byte-for-byte;
the same test files then pass 22/22 and 8/8. Root lint, module-size and
source-assertion gates pass; 425 documentation snippets compile. This is
focused validation, not a claim that the full repository suite passed.
