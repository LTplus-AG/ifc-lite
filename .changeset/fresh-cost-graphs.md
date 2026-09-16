---
"@ifc-lite/sdk": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
"@ifc-lite/sandbox": minor
"@ifc-lite/parser": major
---

Expose the canonical IFC 5D cost read model and decimal evaluation through
`bim.cost`, CLI/headless and MCP backends, MCP tools, viewer-local SDK calls,
remote capability reporting, and the sandbox bridge.

Bound public cost-evaluation precision to 1 through 10,000 significant digits
so caller-controlled division cannot request impractical decimal output.
