---
"@ifc-lite/parser": minor
---

Export the `LengthUnitSource` type (`'declared' | 'default'`) from the package index, so callers can name the type of `IfcDataStore.lengthUnitSource` without a deep import, and say in its JSDoc that the unit is read from the first `IFCPROJECT` (#7395 follow-up).
