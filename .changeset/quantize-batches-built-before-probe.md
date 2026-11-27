---
"@ifc-lite/renderer": patch
---

Bucket batches built before the quantized pipeline probe resolved (a small model that finishes loading first) are rebuilt quantized once the pipelines exist and no stream is running, as a load after the probe draws them. Previously they stayed f32 for the rest of the session, so a small model drew differently from the same model loaded a moment later.
