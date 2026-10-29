---
"@ifc-lite/ids": patch
---

IDS: a missing property-set failure now names the required set (or its pattern/enumeration) instead of the literal `propertySet` when the entity has other property sets (#8306). Constraint names are no longer quoted twice in failure reasons and requirement descriptions in any locale: `Property set "Pset_X" not found` instead of `Property set ""Pset_X"" not found`, and `Property "Pset_WallCommon.FireRating" must exist` instead of `Property ""Pset_WallCommon"."FireRating"" must exist`.

`TranslationService.t()` renders exactly as before for callers passing raw names: the catalogue's constraint slots no longer quote their value (the service now passes self-quoted constraint descriptions), and `t()` restores those quotes, including `"pset.property"` for the property templates' new `{path}` slot.

`IDSFailureDetail.field` for `PSET_MISSING`, `PROPERTY_MISSING` and `ATTRIBUTE_MISSING` is now the bare name the facet requires (`Pset_WallCommon`, not `"Pset_WallCommon"`), as the field's documentation always said. It is the constraint description only when the facet names a pattern or enumeration, and then it equals `expected`.
