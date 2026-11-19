---
"@ifc-lite/export": patch
---

Schema conversion no longer reads a slot that holds only a comment and `$` (or `*`) as a value (#10779). The Rust exporter stops counting such a slot in `attribute_values_dropped`, and both converters write `$` when an attribute map would have carried it.
