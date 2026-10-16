---
"@ifc-lite/server-bin": patch
---

`schema_version` is read from the file's `FILE_SCHEMA` header declaration on every route, with the same rule as the browser parser: the first recognised identifier wins, and an undeclared file falls back to a scan of the file's first bytes, then IFC4. `/parse/metadata` used to miss lower-case declarations, and the geometry routes searched the whole file, so `ifc4` inside a GUID reported many IFC2X3 models as IFC4. Cached JSON responses and Parquet metadata headers move to new keys (`-json-v7`, `-parquet-metadata-v6`, `-parquet-optimized-metadata-v4`), so each affected file is parsed once more on its next request.
