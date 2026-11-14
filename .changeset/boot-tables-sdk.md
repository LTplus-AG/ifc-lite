---
"@ifc-lite/sdk": patch
---

The headless schema lookup reads the schema tables through their getters, so a bundle that loads it does not keep the table constants (decoded when their chunk loads) in another chunk. Same contents.
