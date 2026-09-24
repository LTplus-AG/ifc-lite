---
"@ifc-lite/cli": patch
---

`ifc-lite mutate --json` no longer reports a mutation that did not happen. `applyAttributeMutations` skips an attribute the entity has no slot for and warns on stderr, but it returned only the rewritten text, so the command could not see the skip: it counted one mutation per target unconditionally and published `mutated: 1, warnings: []` for a record it had left byte-identical. It now returns `{ content, applied, skipped }`, the count excludes entities whose every requested attribute was refused, and the JSON carries a `skipped` array with the express id, the attribute, a machine-readable `reason` and the same sentence that goes to stderr.
