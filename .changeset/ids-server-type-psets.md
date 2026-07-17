---
"@ifc-lite/ids": patch
---

IDS validation on server-parsed models now sees type-inherited property sets (#1787). The bridge's `appendInheritedPropertySets` resolved type psets only via `extractTypePropertiesOnDemand`, which bails on the empty `source` buffer of a server-parsed store — so a facet checking a property that lives on the element's `IfcTypeProduct` (rather than the instance) passed on the in-browser path but was invisible on the server path. It now falls back to the prebuilt property table keyed by the type id (resolved through `IfcRelDefinesByType`), mirroring the Lists server-path type fallback. No wire or cache change; the WASM path is unaffected (guarded on empty `source`).
