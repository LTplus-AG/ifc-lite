---
"@ifc-lite/export": patch
---

`convertStepLine` now replaces IfcAlignment, IfcReferent, IfcLinearElement, IfcPositioningElement and IfcLinearPositioningElement with a 9-attribute `IFCPROXY` when converting below IFC4X3, like the other alignment entities. Before, they were renamed to `IFCPROXY` and kept their own attribute list, which wrote an 8-attribute proxy with an alignment enum in `ProxyType` (#7683). All nine alignment and positioning types keep their OwnerHistory, Name, Description, ObjectType, ObjectPlacement and Representation in the proxy, so the alignment's curve and the referents' placements stay attached. The GlobalId is still minted, the source type name fills ObjectType when it was `$`, and the ProxyType is `.NOTDEFINED.`. `convertEntityType` no longer maps the five positioning types to `IFCPROXY`; `shouldSkipEntity` reports them instead. `analyzeConversionLoss` now names only the GlobalId and the attributes after the seventh as dropped for these types.

On an IFC2X3 target, a record whose type the IFC2X3 schema does not declare is now refused even when the source schema does not declare it either. That covers a malformed record headed by a defined type, such as `#1=IFCLABEL('x');`. The Rust exporter already refused these records. A rooted type still becomes an `IFCPROXY`.
