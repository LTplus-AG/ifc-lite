---
"@ifc-lite/viewer": patch
---

Extension exporters and "Export modified IFC…" are now entries of the export registry, so every export surface reaches them (#5838). An installed extension exporter used to appear only as a block inside the Export IFC dialog; it is now a row in the classic Export menu (under "From extensions"), a button in the ribbon's Export group, and a command palette row, and its file is named after the active model. "Export modified IFC…" was only the amber toolbar button; it is now also in the Export menu, the ribbon and the palette (disabled until a model has unexported edits), and every entry opens the same review dialog.
