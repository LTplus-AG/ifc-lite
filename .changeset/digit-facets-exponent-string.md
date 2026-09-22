---
"@ifc-lite/ids": minor
---

Fix `xs:totalDigits`/`xs:fractionDigits` facet evaluation miscounting digits for a numeric property value that arrives as a **string** in scientific notation (e.g. `"1.5e3"`, `"1E3"`): the `e`/`E` character was counted as a digit instead of being normalised away, the same bug the file's own `toFixedDecimalString` helper already prevented for the `number` branch. A string actual in exponential notation is now parsed and re-rendered fixed-point before counting, exactly as a JS `number` actual already is; a string already in fixed-point form (`"0012.3400"`) is untouched. This changes validation outcomes — a bounds constraint with digit facets against an exponential-notation string value can now pass where it previously failed (or vice versa for tighter bounds), so this is `minor` rather than `patch`, matching the reasoning used for the sibling `xs:pattern` subtraction fix.
