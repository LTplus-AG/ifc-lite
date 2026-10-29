---
"@ifc-lite/ids": patch
---

IDS: a missing property-set failure now names the required set (or its pattern/enumeration) instead of the literal `propertySet` when the entity has other property sets (#8306). Constraint names are no longer quoted twice in failure reasons and requirement descriptions in any locale: `Property set "Pset_X" not found` instead of `Property set ""Pset_X"" not found`, and `Property "Pset_WallCommon.FireRating" must exist` instead of `Property ""Pset_WallCommon"."FireRating"" must exist`.

Template change for direct `TranslationService.t()` callers: slots that receive a constraint rendering (attribute `{name}`, classification `{system}`/`{value}`, material `{value}`, `psetMissing*` `{pset}`, `propertyMissing*` `{property}`, `classificationSystem*` `{expected}`) are no longer wrapped in quotes, so pass a quoted value (as `describeConstraint()` returns) where you want quotes. Property requirement/applicability templates name a single `{path}`; `t()` still accepts `pset` + `property` and renders them as `"pset.property"`, as before.

`IDSFailureDetail.field` for `PSET_MISSING`, `PROPERTY_MISSING` and `ATTRIBUTE_MISSING` is now the bare name the facet requires (`Pset_WallCommon`, not `"Pset_WallCommon"`), as the field's documentation always said. It is the constraint description only when the facet names a pattern or enumeration, and then it equals `expected`.
