---
"@ifc-lite/parser": minor
"@ifc-lite/create": minor
"@ifc-lite/cli": minor
---

Two more structural model checks (#9668). `structural-unconnected-member` reports a structural member with no `IfcRelConnectsStructuralMember`, in a file where other members are connected; `ifc-lite validate` now lists it too. `structural-axis-drift` reports a curve member whose end lies more than `axisDriftTolerance` (default 0.05 m, `DEFAULT_AXIS_DRIFT_TOLERANCE`) off the axis of the physical element it is assigned to, with the `distance` in metres. It runs when `structuralConsistencyIssues(store, { physicalAxes })` is given each element's axis; `@ifc-lite/create` reads them with `structuralPhysicalAxes(store)`, by the structural derivation's rules.
