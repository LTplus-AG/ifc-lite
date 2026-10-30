---
"@ifc-lite/export": patch
---

A `{ typed: { type, value } }` attribute value now takes its inner encoding from the defined type's EXPRESS base however the type name is spelled: `IFCLENGTHMEASURE`, `LengthMeasure` and `IfcLengthMeasure` all write `IFCLENGTHMEASURE(3.)`. Upper-case and prefix-less names used to fall back to the JSON value's shape, writing e.g. `IFCLENGTHMEASURE(3)`. Both STEP writers (TS and Rust) agree.
