---
"@ifc-lite/viewer": patch
---

The IFCX data store states its length unit (`lengthUnitScale` 1, `lengthUnitSource` `'default'`) and registers it with the parser, so loading `hello-wall.ifcx` no longer logs "No IFCPROJECT found", and carries `derivedEntities` through to export.
