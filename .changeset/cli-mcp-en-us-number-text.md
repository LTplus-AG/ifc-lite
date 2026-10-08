---
"@ifc-lite/mcp": patch
"@ifc-lite/cli": patch
---

Numbers in MCP tool text and in the CLI's human-readable output (`ifc-lite info`, the geometry report) are now always grouped the en-US way (`2,500`). They used to follow the host's `LC_ALL` / `LANG`, so a Swedish or German machine printed `2 500` or `2.500`. Structured MCP results and `--json` output are unchanged: they already carried plain numbers.
