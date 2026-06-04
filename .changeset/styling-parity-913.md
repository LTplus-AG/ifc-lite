---
"@ifc-lite/wasm": patch
---

Unify IFC mesh styling between the browser and backend rendering paths (#913).

Colour resolution now lives in one shared place (`ifc_lite_processing::style`);
the browser bindings delegate to it instead of carrying their own copy, so the
two Rust paths can no longer drift:

- Default type colours come from a single table. The four types that diverged
  render consistently now — `IfcCurtainWall` (glass blue), `IfcStairFlight`,
  `IfcFurnishingElement` (light wood), `IfcBuildingElementProxy`.
- `IfcIndexedColourMap` is honoured end to end, including the per-triangle split
  (#663 / #858), restoring per-triangle fidelity dropped in the #874 pipeline
  unification.
- Material-appearance styling (`IfcRelAssociatesMaterial` → material chain,
  #407) and the window frame/glass transparent-vs-opaque split resolve
  identically in both paths, and mapped (`IfcMappedItem`) sub-geometry inherits
  its underlying style.
