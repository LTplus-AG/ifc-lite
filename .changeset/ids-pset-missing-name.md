---
"@ifc-lite/ids": patch
---

IDS: a missing property-set failure now names the required set (or its pattern/enumeration) instead of the literal `propertySet` when the entity has other property sets (#8306). Constraint names are no longer quoted twice in failure reasons and requirement descriptions in any locale: `Property set "Pset_X" not found` instead of `Property set ""Pset_X"" not found`, and `Property "Pset_WallCommon.FireRating" must exist` instead of `Property ""Pset_WallCommon"."FireRating"" must exist`.
