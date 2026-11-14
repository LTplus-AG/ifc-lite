---
"@ifc-lite/ids-authoring": patch
---

The IDS gate builds its defined-type name set on first use from `getIfcDataTypes()`, instead of from `IFC_DATA_TYPES` when the module loads. Same set.
