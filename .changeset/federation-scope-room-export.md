---
"@ifc-lite/export": minor
"@ifc-lite/viewer": patch
---

Room export without the slot, and a seed that survives the relay's write budget (#4444).

`Ifc5ExportOptions.stripPathPrefix` removes a namespace prefix from GlobalId-derived node paths (and every `children` reference that names them). A recipient of a shared room keys its reconstructed store by room path (`/<slotId>/<GlobalId>`); the viewer's Export dialog and "Export changes" now pass the slot of a `room:<roomId>:<slotId>` model (`roomExportPathPrefix`), so an exported `.ifcx` carries the model's own `/<GlobalId>` paths — two copies of one file export as two files whose entity nodes are identical and that differ only in their textures. The second copy's "(2)" name suffix now survives `stripExtension`, so the two downloads no longer share one filename. `stripNodePathPrefix` is exported alongside `IFC5_KNOWN_PROP_NAMES`.

The owner's geometry seed resolves a slot's meshes in one transaction: the per-entity placement-baseline stamps used to be one Yjs update — one websocket frame — each, and two copies of AC20-FZK-Haus.ifc (~245 frames in a burst) tripped the collab-server's default per-connection write budget (200 + 60/s). The relay dropped the tail and Yjs held every later frame from the owner pending, so a guest got the second copy without geometry and without a notice. A two-copy seed is now 9 frames (pinned by `owner-seed.frames.test.ts` and the real-fixture test), the viewer's new `ifc-lite:collab:server-url` `localStorage` override lets a built viewer be pointed at a local relay, and `pnpm test:e2e:collab` runs the two-profile browser acceptance (`tests/e2e/collab-federation-scope.e2e.spec.ts`) against a disposable signed relay.
