---
"@ifc-lite/geometry": minor
"@ifc-lite/cli": patch
---

Surface representation items dropped from the mesh output (unsupported IFC type, or the registered processor errored) via new `GeometryDiagnostics.totalUnsupportedItems` / `unsupportedItemsByType` fields. Previously two of these drop sites logged only behind a debug/observability build flag and the other three logged nothing at all, so no build had a signal an element's geometry was missing or incomplete. The viewer now warns in the console when a load drops items; `ifc-lite diagnose-geometry` and `export --diagnostics` print a "Dropped representation items" section.

Only items under a Body representation count. A 2D 'FootPrint' or 'Annotation' representation map, which Revit and ArchiCAD routinely attach to a type, carries `IfcAnnotationFillArea` / `IfcGeometricCurveSet` items that have no processor and are correctly absent from a 3D view; counting those would make a clean model report hundreds of dropped items. A clean model produces no warning.

The count is a lower bound on affected types, not a count of sources or elements: a representation map's dropped item is counted once per walking router, and the native pass builds one router per element while the browser builds one per batch.
