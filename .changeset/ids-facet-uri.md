---
"@ifc-lite/ids": minor
"@ifc-lite/rules": patch
---

IDS facets keep their `@uri`: `IDSPropertyFacet`, `IDSClassificationFacet` and `IDSMaterialFacet` have an optional `uri`, which `parseIDS` reads and `writeIdsXml` writes on requirement facets (IDS 1.0 allows `@uri` only there). A bSDD class or property reference therefore survives a parse/write round trip.
