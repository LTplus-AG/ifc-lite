---
"@ifc-lite/ifcx": patch
---

Fix `bakeLayers`' `dedupeImports` keeping the weakest layer's import metadata (e.g. a pinned `integrity` hash) for a URI shared across layers, while `mergeSchemas` in the same file resolves same-key conflicts with the strongest (last) layer winning. `dedupeImports` now agrees with `mergeSchemas` and with `composeIfcx`'s layer semantics generally: the strongest layer's import wins.
