---
"@ifc-lite/parser": patch
---

The relationship gate no longer decodes all three schema registries to find the relationship types. `getConcreteRelationshipTypes` and `getAllConcreteRelationshipTypes` read the lists `@ifc-lite/codegen` generates with each registry (about 1 KB per schema) instead of walking the decoded registries, so in a bundle a parse of an IFC4 file decodes only the registries it reads. (An unbundled Node import still decodes all three when it loads their modules, because their exported `SCHEMA_REGISTRY` constants are evaluated there.) Same types, in the same order.
