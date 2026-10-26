---
"@ifc-lite/wasm": patch
---

Export plans attribute changes to the exporting application as buildingSMART describes for IfcChangeActionEnum (Rust `ifc-lite-export` API). Objects a plan adds get an `ADDED` owner history owned by that application. Records it changes get a `MODIFIED` history that keeps the original owner and creation date and names the application as last modifier. What counts as changed is the plan's own scope: every object it patches, every rewritten record that carries an owner history (relationships, property and quantity sets, types), and the set holding a value it edits in place. Other rewritten records (materials, shapes, placements) are not attributed separately. Untouched records stay byte-identical. The STEP header names the application as `originating_system`, `ifc-lite <version>` as `preprocessor_version`, and the change time in UTC.
