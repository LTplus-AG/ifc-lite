---
'@ifc-lite/ids': patch
---

Fix an `xs:restriction` carrying only `totalDigits` and/or `fractionDigits` silently rejecting every value it was checked against.

`xs:totalDigits` and `xs:fractionDigits` are legal XSD facets (the IDS XSD's `<xs:restriction>` element re-uses the real XMLSchema type, which is why `packages/ids/src/audit/structural` already lists them as accepted facets) but the parser never recognised them as bounds facets. A restriction with only one of these two facets — no `pattern`/`enumeration`/min-max/length sibling — fell through `parseRestrictionFamilies`'s "no recognised facet" branch to an empty `enumeration` constraint, which `matchEnumeration` fails unconditionally: a spec-conforming value (e.g. `0.25` against `fractionDigits="2"`) was reported non-compliant on 100% of inputs, not just the genuinely out-of-range ones.

`IDSBoundsConstraint` now carries `totalDigits`/`fractionDigits`, the parser reads them, and `matchBounds` evaluates them against the XSD-defined significant-digit count (leading zeros in the integer part and trailing zeros in the fraction are not significant; a zero between the decimal point and the first non-zero fraction digit is). `getConstraintMismatchReason`/`formatConstraint` report which facet rejected the value.
