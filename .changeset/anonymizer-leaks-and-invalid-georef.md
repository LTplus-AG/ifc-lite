---
'@ifc-lite/export': minor
---

Three defects in the anonymized subset export (#3351), all reachable from the viewer.

**"Keep georeferencing" produced an invalid STEP file.** With `removeGeoreferencing: false`, the export still dropped `IfcPostalAddress` unconditionally, leaving `IfcSite.SiteAddress` pointing at a line that was never written, and reported no warning, because the dangling-reference repair only rewrites `IFCREL*` lines and never sees a direct attribute slot. The classes that option governs are now kept when it asks for them, by the mechanism each one needs. An address is a forward reference (`SiteAddress`, `BuildingAddress`, a person's or organization's `Addresses`), so keeping it means only that it is no longer excluded and the export's existing closure walk decides: an address belonging to a site the caller did not select, or to owner history whose `Addresses` slot the scrub blanked, is still absent. `IfcMapConversion`/`IfcProjectedCRS` are referenced only by an INVERSE attribute, so nothing in the file can reach them and they have to be collected explicitly; merely removing them from the exclusion set left them silently absent, and the toggle named "map conversion, CRS, lat/long, addresses" delivered the last two and dropped the first two without a word. `IfcActorRole` is deliberately not among them: it belongs to owner history, which this option does not govern.

**Two leaks on default settings.** `IfcElementType.ElementType` is the type-side twin of `ObjectType` and carries the same authored text ("Basic Wall: <project> Exterior 300"); `IfcMaterial.Category` and `IfcMaterialLayer.Category` are authored text in practice. Both now scrub under the default `pseudonymizeAllNames`, along with `IfcTypeObject.ApplicableOccurrence`, which is the same authored-text slot one level up. The option's doc comment and the exporting guide list all three. `ElementType` had to go in the root-attribute list rather than the non-root one: the slot lookup short-circuits on `IfcRoot` types, and `IfcWallType` is an `IfcRoot`, so the obvious placement would have been inert.

**The test fixture could not fail.** Both leaking slots were `$` in the fixture and `IfcMaterial` was written with one argument, so the "contains none of the source model's identifying strings" sweep was blind to all three gaps however badly they leaked. The fixture now carries values in those slots.

`StepExportOptions` gains an optional `subsetIdentifyingTypes`, which is what carries the caller's answer down to the subset closure.
