---
"@ifc-lite/cli": patch
---

`ifc-lite extract-entities --type IfcWall` selects `IfcWallStandardCase` too, as `query`, `export`, `anonymize` and `mutate` all already do on the same input. It compared `inst.type === t.toUpperCase()` exactly, so the verbatim example in `docs/guide/cli.md` — `--type IfcWall` on a model whose 13 walls are all `IfcWallStandardCase` — selected nothing and exited 1. Because this command runs its own lightweight STEP parse and has no resolved schema version, it uses `expandTypes`' documented no-version union across the bundled schemas rather than picking one table on the caller's behalf.

An empty selection also names the selector that came back empty (`nothing in this file matches --type IfcTank`) instead of advising you to use the flag you just used.
