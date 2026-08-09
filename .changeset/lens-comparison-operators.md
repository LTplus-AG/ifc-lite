---
"@ifc-lite/lens": minor
---

Lens criteria gain the comparison operators `ne`, `gt`, `gte`, `lt` and `lte`,
so numeric conditions such as "Volume > 10" or "Thickness < 200" are
expressible. Previously `operator` was limited to `equals | contains | exists`,
which left the `quantity` criteria type — the one that reads a genuinely numeric
value — able to test only equality.

The new operators are honoured by the `property`, `attribute` and `quantity`
criteria types. The remaining types (`ifcType`, `material`, `classification`,
`model`, `group`) match by identity or substring and ignore `operator`, exactly
as they did before.

Comparison semantics are ported from the viewer's search rule model so a lens
condition and the equivalent search rule agree: `gt`/`gte`/`lt`/`lte` parse both
sides with `Number.parseFloat` and match only when both parse to a finite
number, so a numeric comparison against a non-numeric or non-finite value fails
closed rather than matching via `NaN`; `ne` is a string comparison and is the
exact complement of `equals`. A missing value never satisfies any of the five.

`operator` remains optional and the three existing values are unchanged, so
existing lenses and the shipped presets behave identically.

Adds the `LensOperator` type and the `LENS_OPERATORS` constant to the public
surface so a rule editor can enumerate the operators.
