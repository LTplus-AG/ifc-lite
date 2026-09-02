---
"@ifc-lite/geometry": minor
"@ifc-lite/cli": patch
---

Surface representation items dropped from the mesh output (unsupported IFC type, or the registered processor errored) via new `GeometryDiagnostics.totalUnsupportedItems` / `unsupportedItemsByType` fields. Previously these drops were logged only behind a debug/observability build flag, so a release viewer or server build had no signal that an element's geometry was missing or incomplete. The viewer now warns in the console when a load drops items; `ifc-lite diagnose-geometry` and `export --diagnostics` print a "Dropped representation items" section. A clean model (nothing dropped) is unaffected — no new warning appears.
