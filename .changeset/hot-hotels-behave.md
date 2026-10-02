---
"@ifc-lite/create": patch
"@ifc-lite/mcp": minor
---

Support the six existing type/material SDK methods on loaded MCP models through the shared schema-aware factory, with one public Undo operation per call and live IFC2X3 owner-history resolution.

Validate every material layer and layer-set schema field before creating helpers, so late unsupported attributes leave the overlay, journal and allocator unchanged. Metre dimensions, schema declarations and existing SDK anchor policies are retained.
