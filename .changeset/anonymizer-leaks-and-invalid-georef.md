---
'@ifc-lite/export': patch
---

Three defects in the anonymized subset export (#3351), all reachable from the viewer.

**"Keep georeferencing" produced an invalid STEP file.** With `removeGeoreferencing: false`, the export still dropped `IfcPostalAddress` unconditionally, leaving `IfcSite.SiteAddress` pointing at a line that was never written — and reported no warning, because the dangling-reference repair only rewrites `IFCREL*` lines and never sees a direct attribute slot. The classes that option governs are now kept when it asks for them — and KEPT means rooted. `IfcMapConversion`/`IfcProjectedCRS` are referenced only by an INVERSE attribute, so merely removing them from the exclusion set left them silently absent: the toggle named "map conversion, CRS, lat/long, addresses" delivered the last two and dropped the first two without a word. They are now collected explicitly. `IfcActorRole` is deliberately not among them: it belongs to owner history, which this option does not govern.

**Two leaks on default settings.** `IfcElementType.ElementType` is the type-side twin of `ObjectType` and carries the same authored text ("Basic Wall: <project> Exterior 300"); `IfcMaterial.Category` and `IfcMaterialLayer.Category` are authored text in practice. Both now scrub. `ElementType` had to go in the root-attribute list rather than the non-root one: the slot lookup short-circuits on `IfcRoot` types, and `IfcWallType` is an `IfcRoot`, so the obvious placement would have been inert.

**The test fixture could not fail.** Both leaking slots were `$` in the fixture and `IfcMaterial` was written with one argument, so the "contains none of the source model's identifying strings" sweep was blind to all three gaps however badly they leaked. The fixture now carries values in those slots.
