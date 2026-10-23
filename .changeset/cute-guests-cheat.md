---
"@ifc-lite/cli": patch
"@ifc-lite/sdk": minor
"@ifc-lite/mcp": patch
---

Preserve untouched type-owned property siblings when CLI mutate, gym, SDK, or MCP edits a type definition. Seed property and quantity overlays from HasPropertySets for schema-declared IfcTypeObject subtypes, including IFC2X3 style classes. Expose configureSourceMutationView from the SDK headless entry point for hosts that construct their own overlays.
