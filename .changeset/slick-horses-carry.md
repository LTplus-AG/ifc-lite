---
"@ifc-lite/parser": minor
"@ifc-lite/export": patch
"@ifc-lite/mutations": minor
---

Export default-history type-owned quantity edits through HasPropertySets instead of an invalid IfcRelDefinesByProperties type target. Reuse canonical source type quantity extraction and preserve raw untouched physical quantities, explicit native units, Formula, set metadata, unrelated definitions and shared owners with copy-on-write. Expose extractTypeEntityOwnQuantities for callers reading a type object directly; occurrence-facing and source-only reads retain their existing semantics.

Preserve native quantity definition GlobalIds through canonical instance claiming. Add an opt-in empty-instance projection for native exporters so deleting a last numeric member removes only that definition ownership; ordinary quantity reads retain their default omission behavior.

The current native type-quantity reader includes the resolved explicit IFC unit category so type-owned exports refuse dimension changes that would retain an incompatible unit. Source-only output remains unchanged.
