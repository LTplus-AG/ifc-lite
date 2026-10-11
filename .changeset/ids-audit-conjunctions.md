---
"@ifc-lite/ids": patch
---

`auditIDSDocument` now checks every facet family of a conjunctive `xs:restriction` (a pattern, enumeration and bounds together), not only the first: an inverted bound, an inverted length range, an unparseable bound or an enumeration value outside the base in a later family is reported, at `….value.and[N]`. A bounds restriction holding only `xs:totalDigits` / `xs:fractionDigits` is no longer reported as empty.
