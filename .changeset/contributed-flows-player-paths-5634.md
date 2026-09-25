---
"@ifc-lite/viewer": patch
---

Extension-contributed flow graphs (#5634) now offer the Player and Publish, like a saved graph, while staying read-only (no palette, Save, Delete or Export); a publish credits the namespaced `flow:ext:<extension>:<graph>` id. Uninstalling an extension also clears its graphs' last-used Player values. Exporter and command handler paths written `./x.js` in a manifest, which the loader accepts, now resolve at run time instead of being reported missing.
