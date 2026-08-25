---
'@ifc-lite/clash': patch
---

Clash detection no longer reports a void against the element it cuts.

The non-clashable filter listed `IfcOpeningElement` and `IfcOpeningStandardCase` by hand — one branch of the subtraction family in its IFC4 spelling. `IfcVoidingFeature` (IFC4) and `IfcEarthworksCut` (IFC4.3) are `IfcFeatureElementSubtraction` subtypes too, are meshed like any other product, and were becoming clash candidates, so every such void collided with its host. Subtraction features are now derived from the bundled schema union instead of enumerated, so a class a later schema adds is covered without another edit.

Addition features stay clashable: `IfcProjectionElement` and `IfcSurfaceFeature` are physical material, so a clash against them is a real coordination problem.
