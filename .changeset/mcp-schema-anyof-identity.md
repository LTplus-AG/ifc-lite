---
"@ifc-lite/mcp": minor
---

The MCP input validator now enforces `anyOf`, which it previously accepted in the schema type and documented as supported but never read, and its error names what each branch wanted. `entity_set_property`, `entity_delete_property`, `entity_set_attribute` and `entity_delete` use it to declare their existing `global_id`-or-`express_id` requirement, so a call missing both is rejected at validation instead of inside the handler. `required` is now also honoured on a schema that declares no `properties`, and treats a `null` value as missing (handlers read null and absent alike). An `anyOf` branch no longer matches on the strength of its own defaults. `oneOf`, documented but equally unimplemented and used by no schema, is removed from the doc comment and from the exported `JsonSchema` type (a type-surface removal, hence minor: a consumer reading `schema.oneOf` now sees `unknown`).

`tools/list` does not publish a root-level `anyOf`: the Anthropic Messages API rejects a tool `input_schema` with a root `anyOf`/`oneOf`/`allOf`, failing the whole request, so the rule is stated in the `global_id`/`express_id` descriptions and enforced server-side. A call naming neither id (or only a null one) was already bound to fail in the handler; it now fails at validation, with the same `INVALID_INPUT` code. A `null` passed for a required field is now rejected.
