---
"@ifc-lite/wasm": patch
---

A typed value whose name a file writes in lowercase or CamelCase, such as `ifcreal(1.5)` or `IfcNormalisedRatioMeasure(0.2)`, now reads the same as the uppercase spelling. STEP keywords are case-insensitive, but the decoder kept the file's spelling and its consumers compared it against uppercase names. The JSON, JSON-LD and IFC5 exporters emitted `ifcreal(1.5)` as the string `"1.5"` with a `type` of `"ifcreal"` instead of the number 1.5 with `IFCREAL`, and page appearance refused to preserve a surface style rendering with a lowercase measure ("Unsupported rendering SELECT measure"). The decoder now folds the name to its EXPRESS spelling once, so every consumer, and every exported `type` field, sees `IFCREAL`. Files that already write uppercase keywords are unaffected.
