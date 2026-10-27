---
"@ifc-lite/diff": patch
---

Prepare the internal Rust facade adapters and retryable runtime initialization for fingerprint, lineage, provenance, and sidecar operations. Clean generated output before packaging so removed modules cannot survive a rebuild. Public diff entry points retain their existing initialization contract in this layer.
