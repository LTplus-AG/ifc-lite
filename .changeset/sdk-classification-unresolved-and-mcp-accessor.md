---
"@ifc-lite/sdk": patch
---

`ClassificationData` (the SDK's public classification shape) gained an `unresolved?: boolean` field mirroring `@ifc-lite/parser`'s `ClassificationInfo.unresolved` (#3948/#3951), so a classified-but-unreadable entity (server-parsed store) can be told apart from a genuinely unclassified one through the SDK too.

The MCP playground's own `IFCDataAccessor` implementation (`apps/viewer/src/components/mcp/playground-dispatcher.ts`) built its `getClassifications` result from `m.bim.classifications(...)` (this same SDK shape) but dropped the `unresolved` marker — a second, independent reimplementation of the canonical bridge (`packages/ids/src/bridge/data-accessor.ts`) that the viewer's own IDS panel already uses correctly. Without the field, a classified-but-unresolved entity looked to `checkClassificationFacet` like a real classification with an empty system/value, so the agent's `ids_validate` tool reported a fabricated `CLASSIFICATION_SYSTEM_MISMATCH`/`CLASSIFICATION_VALUE_MISMATCH` instead of the honest `CLASSIFICATION_UNRESOLVED` the same fixture produces through the canonical bridge. Fixed by forwarding `unresolved` through the mapping.
