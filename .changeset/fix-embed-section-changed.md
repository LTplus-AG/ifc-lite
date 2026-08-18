---
'@ifc-lite/viewer-embed': patch
---

Fix the embed viewer never emitting the `SECTION_CHANGED` event.

`SECTION_CHANGED` is a declared `OutboundEventType` (`@ifc-lite/embed-protocol`)
that `@ifc-lite/embed-sdk` exposes to host pages as the `'section-changed'`
event, but nothing in the viewer ever posted it: the `SET_SECTION` bridge
command handler mutated the section-plane store and replied with `RESPONSE`,
and stopped there.

`EmbedViewer.tsx` now subscribes to the section-plane store slice and emits
`SECTION_CHANGED` reactively, the same pattern `CAMERA_CHANGED` and
`ENTITY_SELECTED` already use for `SET_CAMERA`/`SELECT` (so the event also
fires for section changes made through the in-viewer section tool, not only
through `SET_SECTION`). The payload matches `OutboundPayloads.SECTION_CHANGED`
exactly (`axis`, `position`, `enabled` -- `flipped` is not part of the
declared shape, so it is not invented here).
