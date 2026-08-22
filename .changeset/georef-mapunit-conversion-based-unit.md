---
"@ifc-lite/parser": patch
---

Fix a foot-based `IfcProjectedCRS.MapUnit` reading back as metres.

`MapUnit` is an `IfcNamedUnit`, which is either an `IfcSIUnit` or an `IfcConversionBasedUnit` — and attribute 2 means something different in each: `Prefix` on the first, `Name` on the second. Both the browser parser and the Rust extractor read slot 2 as an SI prefix unconditionally, so `'FOOT'` matched no prefix and the reader fell through to its METRE/1.0 default. A georeference authored in feet read back 3.28× wrong, with no warning.

That is the exact form ifc-lite's own exporter writes: `packages/export/src/step-georeferencing.ts` emits `IFCCONVERSIONBASEDUNIT(#dim,.LENGTHUNIT.,'FOOT'|'US SURVEY FOOT',#measure)` for a non-metre map unit. It was invisible because no fixture on either side ever set a non-metre `MapUnit`, so the round-trip only ever exercised METRE — where a broken branch and a correct one give the same answer.

Both readers now branch on the unit's entity type: a conversion-based unit resolves through the shared name table first (`FOOT`, `INCH`, `YARD`, `MILE`) and falls back to the file's own declared `ConversionFactor`, applying the `IfcMeasureWithUnit` unit component's SI prefix — 25.4 expressed in millimetres is 0.0254 m, not 25.4 m. The SI-unit arm is unchanged.
