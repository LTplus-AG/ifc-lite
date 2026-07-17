---
"@ifc-lite/data": minor
"@ifc-lite/export": patch
---

Fix STEP REAL serialization and string-attribute quoting.

`toStepReal` / `serializePropertyValue` (export) and `serializeValue` (data) appended a bare `.` to JavaScript's exponent notation, emitting invalid ISO-10303-21 literals (`5e-8` -> `5e-8.`, `1e21` -> `1e+21.`) and leaving a nonconforming lowercase `e` (`1.5e-7`). A single shared `formatStepReal` helper now performs the mantissa/`E` rewrite (`5.E-8`, `1.E+21`, `1.5E-7`), and `toStepRealScaled` reuses it.

`serializeAttributeValue` (export) now always emits a quoted+escaped STEP string when the edited attribute's source token is a quoted string, so user free-text like `#12`, `$`, `*`, or `.FOO.` can no longer be reinterpreted as an entity reference, null/derived marker, or enum.
