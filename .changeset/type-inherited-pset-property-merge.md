---
"@ifc-lite/parser": minor
"@ifc-lite/ids": patch
---

Fix type-inherited properties disappearing when the occurrence carries a property set of the same name (#1913).

IFC inherits type properties **per property**, not per property set. An occurrence and its `IfcTypeProduct` routinely both carry a set of the same name holding different properties — `Pset_CoveringCommon` with `IsExternal`/`Reference` on an `IfcCovering` and `SurfaceSpreadOfFlame`/`Combustible`/`ThermalTransmittance` on its `IfcCoveringType` is a plain Revit export. Both the IDS bridge and the viewer's Lens adapter treated a name collision as "occurrence replaces type" and dropped the entire inherited set, making every type-only property in it invisible.

For IDS that meant a property that is present, and that other tools resolve, was reported missing: `Property "SurfaceSpreadOfFlame" not found in "Pset_CoveringCommon". Available: Pset_CoveringCommon.IsExternal, Pset_CoveringCommon.Reference`. For Lens it silently removed those properties from grouping and filtering.

`@ifc-lite/parser` gains `mergeInheritedPropertySets(ownSets, inheritedSets)`, which unions the two per property with the occurrence winning on a property-name collision (the more specific definition), matching `IfcRelDefinesByType` semantics. Both consumers now use it, so the rule has one home rather than two divergent copies. Neither input is mutated — cached extractor results stay intact.

Only the collision case changes. A type set whose name the occurrence does not use was already appended and still is; a property defined on both sides still resolves to the occurrence's value; a property on neither side is still absent.
