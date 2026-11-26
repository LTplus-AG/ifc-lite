---
"@ifc-lite/mcp": minor
---

Every tool now has a `title` and all four MCP annotation hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), so clients can auto-approve reads and warn before deletes or file writes. Tool definitions accept `outputSchema` and `icons` and pass them through `tools/list`; the protocol types export `Icon`.

Input validation now enforces `oneOf`, `$ref`/`$defs`, `const`, `pattern`, `uniqueItems` and schema-valued `additionalProperties`. A test fails if any tool schema uses a keyword the validator does not enforce, and every schema must compile under ajv 2020-12 strict mode.

`ids_apply_ops` advertises a compact op list (`kind` enum, `opId`, `payload`) with a generated per-kind field summary. The full op schema moved to the resource `ifc-lite://schemas/ids-ops-v1.json`; the handler still checks every op against it. `tools/list` shrinks from ~143 KB to ~126 KB with the new titles and annotations included, and a test holds it under a budget.

Descriptions of `storey_plan_add`, `bcf_publication_check` and `ids_write` now say what they really do (read-only dry run, local record with a read-only server call, XML returned with no file written).
