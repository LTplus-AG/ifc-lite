---
"@ifc-lite/ids": patch
---

An IDS property facet on an `IfcDescriptiveMeasure` property can pass again.
`ifcMeasureToXsdTypes` decides which XSD types an IDS literal must cast under
before the value comparison runs, and it reached that answer through a
`*MEASURE` / `*RATIO` suffix heuristic. `IfcDescriptiveMeasure` ends in
`MEASURE` but is `TYPE IfcDescriptiveMeasure = STRING;` in both IFC4 and
IFC4X3 — the descriptive-text member of `IfcMeasureValue` — so its literal was
run through a numeric cast that any descriptive text fails, and the facet
reported a mismatch even when the stored value equalled the requested one
character for character.

Three more measures disagreed with their EXPRESS base in the other direction:
`IfcIntegerCountRateMeasure` is `INTEGER`, not `REAL`, so the gate accepted
`3.0`; `IfcParameterValue` (`REAL`) and `IfcPositiveInteger` (`INTEGER`) end in
neither suffix and so got no cast gate at all. All four are now named
explicitly, and a test re-derives the expectation for every measure the
`IfcValue` SELECT can reach directly from the EXPRESS schemas, so the table
cannot drift from them again.
