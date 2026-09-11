---
"@ifc-lite/cli": patch
---

Fix `ifc-lite analyze --isolate` silently leaving the viewer's previous view on screen when a rule matched zero entities, instead of showing the empty result. The `isolateEntities` viewer command is now sent whenever `--isolate` was requested, even with an empty match set — the viewer's `isolateEntities` handler already fades every entity when given an empty id list, which is exactly "isolate to nothing".
