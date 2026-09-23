---
"@ifc-lite/bcf": patch
---

Fix `readBCF` silently returning an empty project for a `.bcfzip` whose entries use backslash path separators (a real historical Windows-zip-writer output). Entry names are normalised to `/` once when the archive loads, so the archive root, topic folders, viewpoints and snapshots all resolve, including in a zipped-folder archive. A `markup.bcf` that no topic folder can claim is now reported through `onWarning` (and the console) instead of reading as a successful empty result.
