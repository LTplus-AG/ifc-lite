---
"@ifc-lite/create": patch
---

`IfcCreator` no longer writes an invalid STEP REAL for values with magnitude >= 1e21. At that size `Number.prototype.toFixed` switches to JavaScript exponent notation (`1e+21`), which has no decimal point in the mantissa, so the fixed-decimal fallback leaked it into the file. Those values are now written in the ISO 10303-21 exponent form (`1.E+21`) using the same `formatStepReal` rule that `@ifc-lite/export` uses. `NaN` and `Infinity` have no STEP REAL spelling, so they now throw instead of being written as `NaN.` / `Infinity.`. Values below 1e21 serialize byte-for-byte as before.
