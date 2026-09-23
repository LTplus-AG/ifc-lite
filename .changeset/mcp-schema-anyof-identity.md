---
"@ifc-lite/mcp": patch
---

The MCP input validator now enforces `anyOf`, which it previously accepted in the schema type and documented as supported but never read, and its error names what each branch wanted. `entity_set_property`, `entity_delete_property`, `entity_set_attribute` and `entity_delete` use it to declare their existing `global_id`-or-`express_id` requirement, so a call missing both is rejected at validation instead of inside the handler. `required` is now also honoured on a schema that declares no `properties`. `oneOf`, documented but equally unimplemented and used by no schema, is removed from the doc comment and the `JsonSchema` type.

`tools/list` does not publish a root-level `anyOf`: the Anthropic Messages API rejects a tool `input_schema` with a root `anyOf`/`oneOf`/`allOf`, failing the whole request, so the rule is stated in the `global_id`/`express_id` descriptions and enforced server-side. Every call that succeeded before still validates; only a call already bound to fail (neither id) now fails earlier, with the same `INVALID_INPUT` code.
