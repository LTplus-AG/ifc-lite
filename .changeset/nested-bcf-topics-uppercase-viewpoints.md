---
"@ifc-lite/bcf": minor
---

Fix `readBCF` silently dropping topics nested below the archive root (e.g. `MyProject/<guid>/markup.bcf`, the shape produced by zipping a folder rather than its contents) and dropping viewpoints named with an uppercase `.BCFV` extension. Both previously vanished with no warning and no error. Topic-folder matching now works at any depth while explicitly excluding `__MACOSX` resource-fork shadow paths, so this is a behaviour change consumers may observe as more topics/viewpoints being read from archives that used to import as empty or incomplete.
