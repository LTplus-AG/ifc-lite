---
"@ifc-lite/viewer-core": patch
---

Build the entity-picking panel with `textContent` instead of string-concatenated `innerHTML`.

`showPickInfo` in the generated viewer HTML wrote the picked entity's IFC type into `#pick-info` by concatenating it straight into `.innerHTML` — the one interpolation site in the file that did this; every other dynamic value (model stats, the command log, the loading text) is written via `.textContent`. `showPickInfo` now builds the panel's rows with `document.createElement` and `.textContent`, matching the pattern used everywhere else.

This is hardening, not a fix for a reachable escape. `info.ifcType` is not attacker-controlled today: it reaches the panel only through `addMeshBatch`, which is fed exclusively by `parseMeshesViaPrePass` → the WASM parser, where the value is `IfcType::name()` — a closed set of generated `"Ifc…"` literals, with any unrecognised keyword collapsing to `Unknown(hash)` whose `name()` is the literal `"Unknown"`. No IFC file and no `/api/create` payload can put `<` or `&` into it. What the change buys is that the panel no longer depends on that guarantee holding: the last interpolation site that would break if the type string ever stopped coming from the enum is gone.
