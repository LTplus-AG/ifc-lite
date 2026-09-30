---
"@ifc-lite/geometry": patch
---

Stop shared-buffer compatibility retries after a WASM runtime trap (#6542). Preserve the first failure instead of replaying a failed instance with a full file copy. Keep non-trap compatibility retries and existing per-entity batch recovery, and direct large-model failures to smaller inputs or the native CLI/server.

Performance verdict: successful mesh production is unchanged; no end-to-end throughput improvement is claimed. Worker contract tests verify that traps avoid the copying retry.
