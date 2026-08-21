---
"@ifc-lite/sdk": minor
"@ifc-lite/cli": patch
"@ifc-lite/mcp": patch
---

Make `bim.mutate.*` persist in the headless CLI and MCP backends instead of silently discarding every edit.

`HeadlessBackend.createMutateAdapter` answered `setProperty`, `setAttribute` and `deleteProperty` with no-ops in both `packages/cli` and `packages/mcp`. Nothing threw and nothing returned a failure, so an `ifc-lite run` script could call `bim.mutate.setProperty` six thousand times, report six thousand edits, and get an export back byte-for-byte identical to its input. The write path that does persist was already present — `MutablePropertyView`, which `StepExporter` reads when `applyMutations` is on, and which `bim.store.*` and `bim.spaces.*` already routed into — nothing connected `bim.mutate` to it.

Both backends now share `createHeadlessMutateAdapter` from `@ifc-lite/sdk`, which owns `MutateBackendMethods` and already depends on `@ifc-lite/mutations`. The adapter takes a thunk rather than a view so the overlay is still built on first write and a read-only session pays nothing.

Values are classified before they are stored. `MutablePropertyView.setProperty` defaults to `PropertyValueType.String`, so forwarding a raw JavaScript value wrote `IFCLABEL('true')` where the caller passed `true`; `propertyValueTypeOf` maps boolean to `IFCBOOLEAN`, whole numbers to `IFCINTEGER` and the rest to `IFCREAL`.

`undo` and `redo` still answer `false` and `batchBegin`/`batchEnd` are still accepted and ignored: the mutation history they would walk belongs to the viewer's store, and a headless session has none. That is now documented at the adapter rather than implied by a bare stub.

Verified on the export, not on the overlay — reading the view back passes against the broken adapter too. With the original no-ops restored, 5 of the 6 new CLI tests fail; the sixth is the control that asserts an unmutated re-export still contains the original name.
