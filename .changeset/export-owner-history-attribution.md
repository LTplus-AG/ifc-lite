---
"@ifc-lite/wasm": patch
---

Export plans attribute changes to the exporting application as buildingSMART describes for IfcChangeActionEnum (Rust `ifc-lite-export` API). Objects a plan adds get an `ADDED` owner history owned by that application. Objects it changes get a `MODIFIED` history that keeps the original owner and creation date and names the application as last modifier. Untouched records stay byte-identical. The STEP header names the application as `originating_system`, `ifc-lite <version>` as `preprocessor_version`, and the change time in UTC.
