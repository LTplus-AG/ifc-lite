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
well. A restriction declaring a single family is unchanged, `and` unset. The
expected-value display and the mismatch reason now name every facet, so a
failure caused by a bound is no longer reported as a pattern expectation.

`xs:totalDigits`, `xs:fractionDigits` and `xs:whiteSpace` are still not read.
