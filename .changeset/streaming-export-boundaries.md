---
"@ifc-lite/export": minor
---

Add `assembleStepBlob`: assembles a STEP file as a multi-part `Blob` built directly from header/entity/newline chunks, with no final contiguous copy of the file content -- suited for the browser download path, which already accepts a `Blob` directly. Also rewrites the internal `assembleStepBytes` (still the one used by `StepExporter`/`MergedExporter`) as a two-pass single-allocation assembler (`TextEncoder.encodeInto`) instead of retaining a persistent `Uint8Array[]` of every encoded entity; output is byte-identical, verified against the previous implementation on a multi-byte UTF-8 corpus.
