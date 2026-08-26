---
"@ifc-lite/ids": patch
---

An `<xs:restriction>` that declares more than one facet now enforces all of
them. `parseRestriction` returned the first family it recognised — pattern,
then enumeration, then bounds/length — and discarded the rest, but XSD facets
in one restriction are conjunctive. Because the discarded facets are the
narrowing ones, this reported models as compliant that were not: a value of
`999` satisfied `minInclusive 10` + `maxInclusive 20` + `pattern \d+`, and
`"ABCDEFGHIJ"` satisfied `maxLength 3` + `pattern [A-Z]+`, in both cases because
only the pattern survived parsing.

The parser now builds every family present. The first stays the constraint
itself, so the `pattern` / `enumeration` / `bounds` switches in the auditor, the
translation layer and the facet checkers see the shape they already handle; the
rest ride along in a new optional `and` list that `matchConstraint` requires as
well. A restriction declaring a single family is unchanged, `and` unset.

Both report paths follow: `formatConstraint`'s expected-value display and
`describeConstraint`'s human-readable text now name every facet, joined by a new
`constraints.conjunction` string in each locale, and the mismatch reason points
at the facet that actually rejected the value. Describing only the primary would
state a weaker requirement than the one being enforced.

Still unchanged: `xs:totalDigits`, `xs:fractionDigits` and `xs:whiteSpace` are
not read at all, and the IDS-document auditors under `audit/` inspect only the
primary family, so a malformed regex or an inverted bound in a sibling facet is
not linted.
