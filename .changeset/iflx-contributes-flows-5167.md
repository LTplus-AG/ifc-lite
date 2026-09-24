---
"@ifc-lite/extensions": minor
---

Add `contributes.flows` (#5167 Phase 4.2): an extension bundle can now ship one or more flow graphs (`*.flow.json`), each declared as `{ id, name, description?, path }` and cross-referenced against the bundle's file list, the same way `contributes.exporters[].handler` is. No `manifestVersion` bump: the contributions validator ignores keys it does not know, so an older host skips `flows` and loads the rest of the extension, and a bump would only have made newly authored bundles, flows or not, unloadable in older viewers. The actual `FlowDocument` content (parse + `validateFlowWiring` + capability bounding against the extension's grants) is resolved host-side, since `@ifc-lite/extensions` does not depend on `@ifc-lite/flow` — see `apps/viewer/src/services/extensions/host-flows.ts`.

`normaliseBundlePath` is exported: the one mapping from a manifest path to its bundle file key (forward slashes, no leading `./`), shared by the loader, the cross-reference validator and host-side lookups.
