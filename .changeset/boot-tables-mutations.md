---
"@ifc-lite/mutations": patch
---

The per-schema attribute-name index reads the schema tables through their getters, so in a bundle loading `@ifc-lite/mutations` decodes no table (In a bundle; an unbundled Node import still evaluates the exported table constants when their modules load.) Same contents.
