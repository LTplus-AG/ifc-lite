---
'@ifc-lite/extensions': minor
---

Fix `bim.model.loadIfc` inferring the read-only `model.read` capability instead of `model.create`.

The inference catalogue mapped every `bim.model.*` call, including `loadIfc`, to the namespace's `model.read` default. `loadIfc` loads a whole new IFC document into the app (dispatches `ifc-lite:load-file`), which is a document-creating operation, not a read — the same distinction `host/permissions.ts` already draws for `model.create` ("creation modifies the document").

Because `inferCapabilities` and the runtime's per-method capability gate (`host/check.ts`) both read this same catalogue, the under-grant was not just a review-screen display issue: an extension granted only `model.read` could call `bim.model.loadIfc` and the gate would allow it, since the required and granted capability were identical (`model.read`). `bim.model.loadIfc` now requires `model.create`; `bim.model.list`/`active`/`activeId` are unaffected and still require `model.read`.
