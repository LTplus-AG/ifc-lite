---
"@ifc-lite/mcp": patch
---

The MCP input validator now enforces `anyOf`, which it previously accepted in the schema type and documented as supported but never read. `entity_set_property`, `entity_delete_property`, `entity_set_attribute` and `entity_delete` use it to declare their existing `global_id`-or-`express_id` requirement in the schema, so a call missing both is now rejected at validation instead of only at runtime inside the handler. `oneOf` — documented but equally unimplemented, and not needed by any schema — is removed from the doc comment and from the `JsonSchema` type rather than left as a second dead keyword.

No call that previously succeeded is affected: every currently-valid shape (either id alone, or both) still validates. Only a call that was already guaranteed to fail (neither `global_id` nor `express_id`) now fails earlier, with the same `INVALID_INPUT` error code.
