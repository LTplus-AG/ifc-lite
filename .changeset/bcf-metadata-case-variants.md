---
"@ifc-lite/bcf": patch
---

`readBCF` now reads `bcf.version` and `project.bcfp` when their names differ only in case (for example `MyProject/BCF.VERSION`), at the archive root and inside a wrapped project folder. Previously the wrapped root was matched case-insensitively and then read under a lowercase name that did not exist, so the import failed with `missing bcf.version`.
