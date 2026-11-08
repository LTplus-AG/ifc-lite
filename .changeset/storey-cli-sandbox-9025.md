---
"@ifc-lite/cli": minor
"@ifc-lite/sdk": minor
"@ifc-lite/sandbox": minor
"@ifc-lite/mcp": patch
"@ifc-lite/viewer": patch
---

Storey authoring from the CLI and scripts (#9025, follow-up to #9013). `ifc-lite storey <file> list|add|rename|edit|delete` lists storeys, adds them with the neighbours' naming and spacing, re-levels them (`--elevation` or `--floor-height`), and deletes them (`--move-to` or `--delete-contents`), with `--dry-run` and `--json`. It runs the same `bim.store` path as the viewer and MCP, so geometry follows storeys and every refusal is reported before anything is written. `bim.store.suggestStorey` exposes the neighbour-based defaults, and MCP `storey_add` now uses it. Scripts in the viewer's sandbox get the storey methods, typed in the generated `bim` globals, and the assistant's store method list includes them.
