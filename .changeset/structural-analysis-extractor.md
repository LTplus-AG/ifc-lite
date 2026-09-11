---
'@ifc-lite/parser': minor
---

Add a structural analysis extractor: `extractStructuralOnDemand` reads IfcStructuralAnalysisModel, the IfcStructuralMember / IfcStructuralConnection / IfcStructuralActivity branches, IfcStructuralLoadGroup and IfcStructuralLoadCase, IfcStructuralResultGroup, IfcBoundaryCondition, IfcRelConnectsStructuralMember, IfcRelConnectsStructuralActivity and IfcRelAssignsToGroup into one connected `StructuralExtraction`, cross-linked by GlobalId.

Which types count is derived from each type's inheritance chain, and where each attribute sits is resolved from the generated schema registry by EXPRESS attribute name, so a subtype outside the named branches reads correctly without a table entry. Loads and boundary conditions report their components under their exact EXPRESS attribute names, keeping an `IfcBoolean` stiffness boolean rather than collapsing a rigid support to the number 1.
