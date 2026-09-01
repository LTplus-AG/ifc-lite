---
'@ifc-lite/ids': patch
---

Fix an `xs:restriction` carrying only `totalDigits` and/or `fractionDigits` silently rejecting every value it was checked against.

`xs:totalDigits` and `xs:fractionDigits` are legal XSD facets (the IDS XSD's `<xs:restriction>` element re-uses the real XMLSchema type, which is why `packages/ids/src/audit/structural` already lists them as accepted facets) but the parser never recognised them as bounds facets. A restriction with only one of these two facets — no `pattern`/`enumeration`/min-max/length sibling — fell through `parseRestrictionFamilies`'s "no recognised facet" branch to an empty `enumeration` constraint, which `matchEnumeration` fails unconditionally: a spec-conforming value (e.g. `0.25` against `fractionDigits="2"`) was reported non-compliant on 100% of inputs, not just the genuinely out-of-range ones.

`IDSBoundsConstraint` now carries `totalDigits`/`fractionDigits`, the parser reads them, and `matchBounds` evaluates them per XSD §4.3.11/§4.3.12 (value = i × 10⁻ⁿ): `fractionDigits` is `n`, the count of digits after the decimal point — leading fraction zeros DO count here since they fix the magnitude (`0.0025` → 4). `totalDigits` is the digit count of `i` — leading zeros, in the integer part AND in the fraction before the first non-zero digit, are absorbed into the `10⁻ⁿ` scale factor and do NOT count (`0.0025` → 2, not 4); trailing fraction zeros are dropped from both. `getConstraintMismatchReason`/`formatConstraint` report which facet rejected the value.
