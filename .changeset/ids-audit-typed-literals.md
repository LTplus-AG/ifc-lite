---
"@ifc-lite/ids": patch
---

`auditIDSDocument` reports a property `<simpleValue>` that is not a literal of the property `dataType`'s XSD type (`E_RESTRICTION_VALUE_MISMATCH`): an upper-case boolean (`FALSE`), an integer written with a decimal point (`42.0`, `42.`), or a number with a decimal comma (`42,3`). Such a value can never equal a real one. Six more `invalid-` cases of the buildingSMART IDS corpus are detected (12 of 27).
