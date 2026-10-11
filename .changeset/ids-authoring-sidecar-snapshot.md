---
"@ifc-lite/ids-authoring": minor
---

`studio.json` now embeds a versioned content snapshot (`snapshot: { version: 1, ids }`), so a standalone `.idsz` bundle whose XML was edited elsewhere is re-identified without the previous document. `attachSidecar` reports `basis: 'snapshot'` or `basis: 'previous'` on a re-identified result. Sidecars without a snapshot still load, and `createSidecar(doc, xml, { snapshot: false })` leaves it out. New exports: `SIDECAR_SNAPSHOT_VERSION`, `SidecarSnapshot` and `CreateSidecarOptions`.
