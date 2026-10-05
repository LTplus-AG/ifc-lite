---
"@ifc-lite/mcp": patch
"@ifc-lite/cli": patch
---

Thousands separators in MCP tool text and CLI reports (`info`, geometry diagnostics) are now always en-US (`2,500`), no longer taken from the host's `LANG` (a Swedish or German host printed `2 500` / `2.500`).
