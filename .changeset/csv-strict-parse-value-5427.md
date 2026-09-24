---
"@ifc-lite/mutations": patch
"@ifc-lite/flow-nodes": patch
---

`parseValue` and `CsvConnector` now accept a Real, Integer, Boolean or Logical cell only when the whole cell is a value of that type (#5427). Values that were silently coerced before are now reported per cell and left unwritten: `12,5` or `60abc` in a Real column (previously written as 12 and 60), `2.7` in an Integer column (previously 2), and any word other than true/false/yes/no/1/0 in a Boolean or Logical column, such as `ja` or `UNKNOWN` (previously `false`). A property match on such a cell no longer selects entities either. `generateMutations` reports each skipped cell through its `warnings` array. Surrounding whitespace and exponent notation (`1.2E-05`) are still accepted; a decimal comma is refused rather than guessed. The flow table nodes already applied this check and now share the same function, so their behaviour is unchanged.
