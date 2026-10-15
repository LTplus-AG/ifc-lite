---
"@ifc-lite/ai": patch
---

`MODEL_DATA_CHANGE_OUTPUT_GUIDANCE` now asks for booleans and numbers in `expected` as JSON values, not text (#7650). The viewer also accepts `"true"`/`"false"` against a boolean property and writes a boolean.
