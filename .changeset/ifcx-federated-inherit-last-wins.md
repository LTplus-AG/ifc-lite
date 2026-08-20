---
"@ifc-lite/ifcx": patch
---

Fix `composeFederated`'s handling of a node with multiple simultaneous `inherits` keys: it resolved conflicting attributes/children with the first-listed inherit winning, while `composeIfcx` (and the buildingSMART IFC5 reference composer) resolve them with the last-listed inherit winning. Given identical input, the two composers previously disagreed on the composed value; `resolveInheritance` in `federated-composition.ts` now matches `composeNode` in `composition.ts`, and own (occurrence-level) attributes still always outrank any inherited value in both.
