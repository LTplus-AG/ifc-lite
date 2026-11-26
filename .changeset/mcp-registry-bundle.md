---
"@ifc-lite/mcp": patch
---

`package.json` declares `mcpName: io.github.LTplus-AG/ifc-lite` so the MCP Registry can verify the npm package. `pnpm --filter @ifc-lite/mcp release:manifests` builds the registry `server.json` (schema 2025-12-11) and a Claude Desktop bundle `ifc-lite-<version>.mcpb` from the current version.
