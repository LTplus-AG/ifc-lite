---
"@ifc-lite/viewer": minor
---

Add a portable federation setup file: save which models make up a federation (load order, visibility, and the alignment anchor) and reopen it later by matching saved slots back to local files by content fingerprint. The file references source files by name, size, and a content fingerprint — it never embeds file bytes, paths, or handles. Reopening replays the existing alignment pipeline against the restored anchor rather than storing baked transforms, and always reports how many models were restored versus missing or mismatched instead of silently accepting a partial restore. Reachable via the command palette ("Save Federation Setup" / "Open Federation Setup").
