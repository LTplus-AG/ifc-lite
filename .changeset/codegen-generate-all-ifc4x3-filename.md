---
'@ifc-lite/codegen': patch
---

`generateAll()` named the IFC4X3 schema file as `IFC4X3_ADD2.exp`, but the
schema actually shipped in `schemas/` is `IFC4X3.exp`. The function does not
throw or exit non-zero when a named schema file is missing — it logs a
warning and moves on — so calling `generateAll()` silently produced only the
`ifc4/` output directory and skipped `ifc4x3/` entirely, with no error to
signal that a whole schema had gone missing.

`generateAll()` is not exercised by any script in this repo (the package.json
`generate:ifc4x3` script calls the CLI directly with an explicit path), so the
mismatch was invisible here, but it is exported from the package's public API
for anyone using `@ifc-lite/codegen` as a library.

Fixed the filename and added a regression test that runs `generateAll()`
against the real `schemas/` directory and asserts both output directories are
produced.
