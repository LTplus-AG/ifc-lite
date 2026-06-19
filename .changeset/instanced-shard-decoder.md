---
"@ifc-lite/geometry": patch
---

Add a decoder for the instanced ("IFNS") geometry shard format
(`decodeInstancedShard`, `isInstancedShard`). It mirrors the Rust
`encode_instanced`/`decode_instanced` codec and carries each unique template
geometry once plus a per-occurrence instance row (transform + entity id +
colour), so a future renderer path can upload a template once and GPU-instance
its occurrences. Additive and unused by the default path; verified against a
Rust-produced fixture (cross-language round-trip + expand-to-flat).
