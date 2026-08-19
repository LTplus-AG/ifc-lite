---
"@ifc-lite/mcp": patch
---

Fix `mutation_batch` dispatching each sub-op with its raw, pre-validation `args` instead of `validateInput`'s validated result.

Same shape as the collab-server bug in #2846: `mutation_batch`'s per-op loop already calls `validateInput(tool.inputSchema, subArgs)` and checks `validation.valid`, but then handed `subArgs` — the original, unvalidated object — to `tool.handler`, discarding `validation.value`. A single, non-batched call to the same tool goes through `MCPServer.handleToolCall`, which correctly dispatches with `validation.value` (the schema-default-filled result).

No sub-tool on the batch whitelist (`entity_set_property`, `entity_delete_property`, `entity_set_attribute`, `entity_create`, `entity_delete`) currently declares a schema `default`, so this had no observable effect today — but the moment one does, a batched call and a single call would silently disagree about what an omitted field means, exactly like the `handleMessage`/`verifyWithReplayProtector` divergence, and the mismatch would be invisible to any test that only exercises `validateInput` in isolation or only exercises the reject path through `mutation_batch`.

`mutation_batch` now dispatches with `validation.value`, matching the single-call path.
