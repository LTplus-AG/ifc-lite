---
"@ifc-lite/geometry": patch
---

Default content-dedup OFF on the production geometry paths — it was making large-model loads slower, not faster.

The item-level content-dedup (skip re-meshing structurally-identical representation items) builds its 128-bit structural key by recursively decoding the *entire* item subtree (every face, loop, and point entity) with the general decoder — roughly 3.5× more work than the mesher's cached decode of the same item. On real models the hash therefore costs more than the meshing it skips: measured on two large structural models, loads were **20–30% slower** with dedup on (it only paid off at near-100% duplicate hit-rate). Gated both production batch paths (native rayon pool + wasm) behind `GeometryRouter::content_dedup_enabled()` (default `false`); geometry output is byte-identical. The separate `IfcMappedItem` instancing cache is unaffected. A follow-up will make the structural hash walk the cached fast paths so dedup can be re-enabled as a net win.
