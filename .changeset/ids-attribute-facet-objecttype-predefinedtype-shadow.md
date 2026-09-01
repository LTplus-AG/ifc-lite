---
'@ifc-lite/ids': patch
---

Fix an IDS `<attribute><name>ObjectType</name></attribute>` requirement reading the wrong IFC attribute when the entity's `PredefinedType` is a concrete, non-`USERDEFINED`, non-`NOTDEFINED` enum token.

`checkAttributeFacet`'s `ObjectType` lookup went through `accessor.getObjectType`, the helper `matchPredefinedType` uses to resolve the USERDEFINED-name fallback (its own doc: "entity object type (predefined type)"). For an entity like `IfcWall` with `PredefinedType = STANDARD` and its own, unrelated `ObjectType = 'Steel I-Beam 200x100'`, that helper short-circuits on the `PredefinedType` enum and never looks at the entity's actual `ObjectType` attribute — so a required-and-present `ObjectType` value requirement was checked against `'STANDARD'` instead, and failed. The bridge's generic `getAttribute('ObjectType', …)` had the same conflation.

`ObjectType` now routes through the plain attribute path (the same one `Tag`, `LongName`, and every other named attribute uses), which reads the entity's real attribute value; `PredefinedType` requirement checks are unaffected. Same root cause as #2316 (`getAncestors` sourcing a partOf parent's predefined-type match from `getObjectType` instead of the raw enum), here on the plain attribute-facet path instead of `partOf`.
