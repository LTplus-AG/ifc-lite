---
"@ifc-lite/cli": minor
---

`ifc-lite oci push` now writes the provisional IFC release profile annotations on the manifest and the layer: `org.buildingsmart.ifc.profile` (`ifc-release/0`) and `org.buildingsmart.ifc.schema` (from the file's `FILE_SCHEMA`). subsoil writes the same keys. They are a working convention, not a buildingSMART standard, and may change. `--annotation` cannot set them.
