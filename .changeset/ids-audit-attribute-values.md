---
"@ifc-lite/ids": patch
---

`auditIDSDocument` checks an attribute `<value>` against the attribute's own XSD type on the applicability entity, also when the attribute name is a pattern or an enumeration: a simple value that is no literal of that type (`FALSE` for `IfcTask.IsMilestone`, `42.0` for `IfcStairFlight.NumberOfRisers`, `42,3` for a real) is `E_RESTRICTION_VALUE_MISMATCH`, and a restriction on an incompatible base (an `xs:string` pattern on a real-valued attribute) is `E_RESTRICTION_BASE_MISMATCH`. Eight more `invalid-` cases of the buildingSMART IDS corpus are detected (20 of 27).
