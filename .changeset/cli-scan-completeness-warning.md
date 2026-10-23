---
'@ifc-lite/cli': patch
---

Warn on stderr when the scan drops or skips records the file declares (an unterminated or unescaped string, an unreadable record, an id too large to index). Every command loaded such a model silently, so `mutate` and `export` wrote files missing those records with nothing said. `mutate --id` now names the dropped records as the likely cause when the id it was given is not found.
