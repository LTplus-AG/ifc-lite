---
"@ifc-lite/create": patch
---

LandXML→IFC: the refusal of rail cant and road superelevation now names every written alignment carrying them, with its `CantStation` / `Superelevation` block count, and gives the IFC 4.3 reason instead of "has no mapping" (mapping spec §13, #5634).

Cant stays refused because IFC 4.3 permits an `IfcAlignmentCant` only beside a vertical layout, and its required `IfcSegmentedReferenceCurve` cannot yet be checked against an independent engine: IfcOpenShell 0.8.5's cant mapping gives the same geometry whether the left or the right rail is raised. Superelevation stays refused because `Pset_Superelevation` needs a cross slope and a side at every event, and LandXML does not carry the normal-crown slope or the side. The exported IFC is unchanged.
