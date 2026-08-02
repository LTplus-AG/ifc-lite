---
"@ifc-lite/cli": patch
---

Fix HBJSON export ignoring in-store edits. `export.hbjson` read the model's original bytes rather than the mutation view, so spaces authored in the editor were invisible to the exporter by construction and the file came back with no rooms. It now regenerates through `StepExporter` when the overlay carries pending changes, matching what STEP export already did, and falls back to the original bytes otherwise.

The gate is `hasPendingChanges()`, not `hasChanges()`: the latter reads the append-only mutation history, which `restoreNewEntity` does not touch, so a restored overlay would have silently taken the original-bytes path and dropped its spaces again.

Closes #1908.
