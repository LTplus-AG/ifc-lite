---
"@ifc-lite/ids": minor
---

Fix `xs:totalDigits`/`xs:fractionDigits` counting the wrong digits for a value in scientific notation (#5186). A string such as `"1.5e3"` or `"1E3"` had its `e`/`E` and exponent digits counted as digits of the value. The digit counter now reads the exponent and applies it arithmetically to the lexical digits, so `"1.5e3"` counts as 1500 (4 total, 0 fraction). The count stays exact beyond double precision, and a huge exponent is never expanded into a string. Both the pass/fail check and the failure-reason text use the same counter. Validation outcomes can change for digit facets checked against exponential values, so this is `minor`.
