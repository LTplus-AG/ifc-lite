---
"@ifc-lite/parser": patch
---

Bound the `IfcDerivedUnit -> IfcDerivedUnitElement -> Unit` walk in unit resolution, as the Rust resolver already is (#4603) (#ISSUE). Behaviour changes:

- A derived unit that names itself, directly or through other derived units, no longer throws `RangeError: Maximum call stack size exceeded` from `extractProjectUnits`, `extractPropertiesOnDemand`, `extractQuantitiesOnDemand` and the readers built on them (the IDS bridge, rules). It is unresolved, reported the way any unit these readers cannot resolve already is: a property's own `Unit` reads as its STEP reference with no scale, a quantity's own unit as `explicitUnitUnresolved`, and a unit in the project assignment is skipped, or kept declared without a scale when some of its elements composed (the existing "incomplete" rule, #4833), where Rust skips it in both cases.
- A chain of 16 or more nested derived units is now unresolved on both read paths; 15 still resolve. On the parsed-source path such a chain resolved before up to between 1,000 and 1,500 levels, depending on the stack, and threw `RangeError` beyond. On the native read path it resolved within the caller's 512-read limit and is now refused as `Native project unit is unresolved or unsupported`. A real derived unit nests one level.
- On the parsed-source path, a derived unit whose resolution needs more than 256 entity reads is now unresolved. That covers an acyclic fan-out, which before took seconds and composed a symbol exponential in its depth, and a flat unit of 128 or more elements over SI units, which before resolved at once.
- The native read path keeps its own 512-read limit and its `exceed the read limit` refusal (#7353): the 256-read budget does not apply there.
