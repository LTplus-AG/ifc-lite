---
'@ifc-lite/data': patch
---

Test-infrastructure change only, no behaviour change: `escapeStepString`'s coverage in `packages/data/src/step-serializers.test.ts` no longer carries a hand-written literal table asserting it matches the Rust escaper's (`ifc_lite_export::step_text::escape`) output on the same inputs. That table, and the Rust side's own hand-written table pinning the TypeScript output, are replaced by one shared vector fixture (`rust/export/tests/fixtures/step_escape_vectors.json`), consumed by both `packages/data/src/step-escape.parity.test.ts` and `rust/export/tests/step_escape_parity.rs`. This follows the precedent set for the CSV-cell escaper (`csv_cell_vectors.json`) — two independently hand-kept copies of the same expected behaviour can drift apart silently (#3284 shipped exactly that way), where one shared fixture cannot.

A new `check:step-escapers` script (mirroring `check:csv-escapers`) fails CI if a third full implementation of the escaper appears outside the two canonical ones.
