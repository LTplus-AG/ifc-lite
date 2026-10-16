---
"@ifc-lite/export": patch
---

`convertStepLine` now replaces IfcAlignment, IfcReferent, IfcLinearElement, IfcPositioningElement and IfcLinearPositioningElement with a full 9-attribute `IFCPROXY` when converting below IFC4X3, like the other alignment entities. Before, they were renamed to `IFCPROXY` and kept their own attribute list, which wrote an 8-attribute proxy with an alignment enum in `ProxyType` (#7683). `convertEntityType` no longer maps these five types to `IFCPROXY`; `shouldSkipEntity` reports them instead.
