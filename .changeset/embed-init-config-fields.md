---
'@ifc-lite/viewer-embed': patch
---

Apply every field of an INIT command's `config` payload, not just `theme`.

`InboundPayloads['INIT']`'s `config` field is the published `EmbedConfig` type (`packages/embed-protocol`) — `theme`, `bg`, `controls`, `hideAxis`, `hideScale`, `hideTypes`. Only `theme` ever reached an actuator; the other five were declared and silently dropped for anyone driving the postMessage protocol directly (the SDK itself never populates `config` at all — it only ever sends `token`, and every one of these fields already has a `?param=` URL equivalent that IS applied). A host setting `config.controls` or `config.hideAxis` on INIT, expecting the same effect its URL-param sibling gets, got nothing.

Each field now reuses the exact actuator its URL param already calls (`setInteractionMode` for `controls`, `setBackgroundColor` for `bg`), so INIT and the URL params cannot drift from each other. `hideAxis`/`hideScale`/`hideTypes` previously had no actuator at all outside the one-time URL parse — `EmbedViewer` read them from a plain object captured once in a `useState` initialiser — so this also makes those three genuinely mutable at runtime via `useEmbedRuntimeOverlays`, not just at mount.
