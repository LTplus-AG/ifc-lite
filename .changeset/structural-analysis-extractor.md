---
'@ifc-lite/parser': minor
---

Add a structural analysis extractor: `extractStructuralOnDemand` reads IfcStructuralAnalysisModel, the IfcStructuralMember / IfcStructuralConnection / IfcStructuralActivity branches, IfcStructuralLoadGroup and IfcStructuralLoadCase, IfcStructuralResultGroup, IfcBoundaryCondition, IfcRelConnectsStructuralMember, IfcRelConnectsStructuralActivity and IfcRelAssignsToGroup into one connected `StructuralExtraction`, cross-linked by GlobalId.

An `IfcStructuralLoadConfiguration` reports one entry per `Values` slot, each carrying the `Locations` row at that same slot, so a nested load the reader could not resolve keeps its position with `value` absent and a `dropped` reason instead of shifting every later load onto an earlier station. `configuration.truncated` and `StructuralExtraction.loadsTruncated` say when a bound of the reader — the nesting cap, the node budget or the cycle guard — stopped the walk, so a truncated configuration is distinguishable from a genuinely small one.

Which types count is derived from each type's inheritance chain, and where each attribute sits is resolved from the generated schema registry by EXPRESS attribute name, so a subtype outside the named branches reads correctly without a table entry. Loads and boundary conditions report their components under their exact EXPRESS attribute names, keeping an `IfcBoolean` stiffness boolean rather than collapsing a rigid support to the number 1.
