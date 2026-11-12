---
"@ifc-lite/parser": patch
---

The relationship gate no longer decodes all three schema registries to find the relationship types. `getConcreteRelationshipTypes` and `getAllConcreteRelationshipTypes` read the lists `@ifc-lite/codegen` generates with each registry (about 1 KB per schema) instead of walking the decoded registries, so a parse of an IFC4 file decodes only the registries it reads. Same types, in the same order.
