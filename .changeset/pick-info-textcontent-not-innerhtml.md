---
"@ifc-lite/viewer-core": patch
---

Fix the entity-picking panel building its markup with string-concatenated `innerHTML` instead of `textContent`.

`showPickInfo` in the generated viewer HTML wrote the picked entity's IFC type into `#pick-info` by concatenating it straight into `.innerHTML` — the one interpolation site in the file that did this; every other dynamic value (model stats, the command log, the loading text) is written via `.textContent`. `ifcType` comes from the mesh data the viewer receives at runtime, not a fixed string, so a value containing `<`/`&` would have been parsed as markup rather than displayed as text. `showPickInfo` now builds the panel's rows with `document.createElement` and `.textContent`, matching the pattern used everywhere else in the file.
