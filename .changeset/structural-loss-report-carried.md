---
"@ifc-lite/export": patch
---

The IFC2X3 <-> IFC4 conversion loss report no longer lists an attribute a structural carrier brings back on the round trip: CausedBy, Axis, varying thicknesses, SelfWeightCoefficients, SharedPlacement, and a load configuration's Values with a NOTDEFINED curve or surface action PredefinedType. The report runs the export's own carrier decisions per record, so a record the carrier does not cover still reports the loss.

The report keeps one entry per source type. When records of that type lose different attributes, the entry also lists the record groups and their exact losses.
