---
"@ifc-lite/codegen": minor
---

Each generated schema bundle (`@ifc-lite/codegen/ifc4`, `/ifc4x3`, `/ifc2x3`) exports `CONCRETE_RELATIONSHIP_TYPES`: every concrete `IfcRelationship` subtype of that schema as an upper-cased STEP keyword, in registry order, generated from the registry. A relationship gate can be built from it without decoding the registry.
