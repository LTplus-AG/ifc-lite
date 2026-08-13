---
"@ifc-lite/data": minor
"@ifc-lite/ifcx": patch
---

One constant for the IFCX header version, exported as `IFCX_VERSION` from `@ifc-lite/data` and re-exported by `@ifc-lite/ifcx`.

Seven call sites hardcoded this string and they did not agree: six said `ifcx_alpha`, and `@ifc-lite/ifcx`'s own `IfcxWriter` said `IFCX-1.0`. Nothing caught it because `parseIfcx` matches case-insensitively on the substring `ifcx`, so both parse. The same forgiving read is why the Rust exporter could write the version under `header.version` for its entire life while every file it produced was rejected by our own parser (#2556).

**Behaviour change:** `IfcxWriter` / `exportToIfcx` now stamp `ifcx_alpha` instead of `IFCX-1.0`, matching every other writer here and buildingSMART's own reference files. Readers accepting either value are unaffected, and no internal caller was relying on the old string. Layer content addresses are unaffected — the layer paths already wrote `ifcx_alpha`.
