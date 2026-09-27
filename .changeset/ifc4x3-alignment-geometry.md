---
"@ifc-lite/wasm": patch
---

IFC4x3 alignment geometry: `IfcSectionedSolidHorizontal` now accepts `IfcAxis2PlacementLinear` cross-section positions (previously every such solid was dropped), `IfcLinearPlacement` and sectioned-solid directrices on an `IfcGradientCurve` follow its vertical profile instead of sitting at z = 0, and alignment `IfcCurveSegment`s (line / circle / clothoid) are sampled densely instead of as one chord per segment.
