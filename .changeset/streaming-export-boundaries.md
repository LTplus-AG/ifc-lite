---
"@ifc-lite/export": minor
---

Add `MergedExporter.exportBlobAsync` (and its `MergeBlobExportResult` type): assembles the merged STEP file as an off-heap multi-part `Blob` instead of one contiguous `Uint8Array`, so the largest STEP output ifc-lite produces (every federated model concatenated) never materialises as a single buffer on the JS heap. The viewer's merged-export download now uses it, handing the Blob straight to the download path with no copy. Byte content is identical to `exportAsync`. Also rewrites the internal `assembleStepBytes` (used by `StepExporter`/`MergedExporter`) as a two-pass single-allocation assembler (`TextEncoder.encodeInto`) instead of retaining a persistent `Uint8Array[]` of every encoded entity; output is byte-identical, verified against the previous implementation on a multi-byte UTF-8 corpus.
