---
"@ifc-lite/mcp": minor
"@ifc-lite/ids-authoring": minor
---

The MCP server gains eight IDS authoring tools that need no model: `ids_audit`, `ids_lint`, `ids_read`, `ids_apply_ops`, `ids_write`, `ids_schema_search`, `ids_schema_entity` and `ids_schema_pset`. Documents travel between calls as Studio JSON with content-derived node ids. `ids_apply_ops` is the only tool that changes a document: every op is validated against the op JSON Schema (which is part of the tool's input schema) and the batch passes the grounding gate first. A batch with a name the IFC schema tables do not have is refused as a whole, and the result carries each problem's gate code, path and ranked candidates. `ids_write` re-reads and audits what it writes and refuses a document with audit errors.

`@ifc-lite/ids-authoring` exports the pieces behind them: `applyOpsGated(doc, ops, ctx)` (validate, gate, apply; never applies part of a batch) and the schema lookups `searchSchema`, `describeEntity` and `describePset`.
