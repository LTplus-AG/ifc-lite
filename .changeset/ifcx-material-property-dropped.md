---
'@ifc-lite/ifcx': patch
---

Fix `extractProperties` silently dropping an element's `bsi::ifc::material` attribute when reading an IFCX archive.

`bsi::ifc::material` (`{ code, uri }`) is the only channel IFCX carries an element's material on — buildingSMART's PCERT sample scenes author it on most physical elements (walls, beams, columns, pipe and track segments). `property-extractor.ts`'s `SKIP_ATTRIBUTES` set treated it the same as graph-structural attributes (`bsi::ifc::class`, `usd::usdgeom::mesh`, `usd::xformop`), so it was skipped before ever reaching a property or a relationship: nothing else in the package read it either, so the material vanished entirely on import, with no error. A STEP-sourced model surfaces the same information via `IfcRelAssociatesMaterial` in the viewer's Material tab and the query engine.

`bsi::ifc::material` is now unpacked into its own `Material` property set (`Material` = the material code, `Uri` = its buildingSMART identifier) instead of being skipped.
