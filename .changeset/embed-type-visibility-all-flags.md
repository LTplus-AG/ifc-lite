---
'@ifc-lite/embed-protocol': minor
'@ifc-lite/embed-sdk': minor
'@ifc-lite/viewer-embed': patch
---

`SET_TYPE_VISIBILITY` reaches all seven type-visibility toggles, not three of them.

The viewer store has seven type-visibility controls; the embed protocol declared three (`spaces`, `openings`, `site`). The protocol was written when the store had three, and nothing tied the two sets together, so `spatialZones`, `virtualElements`, `ifcAnnotations` and `ifcGrid` were added to the store and silently never reached a host. A host that sent one got an OK response and no effect.

`@ifc-lite/embed-protocol` gains `TYPE_VISIBILITY_FLAG_KEYS` (a runtime list of all seven, in store order) and `TypeVisibilityFlags` (the payload type built from it, with a doc comment naming the IFC classes each flag gates). `SET_TYPE_VISIBILITY`'s payload is now that type, and `setTypeVisibility` in `@ifc-lite/embed-sdk` takes it instead of its own inline three-field copy. Both are additive: an existing three-field call still compiles and still means the same thing.

Two smaller fixes ride along in the embed viewer. The command handler loops `TYPE_VISIBILITY_FLAG_KEYS` instead of naming three flags by hand, keeping the same "only toggle a flag that actually differs" rule. And the embed's mesh filter now calls `isTypeVisible` from the store's `typeVisibilityFilter`, the file that calls itself the single source of truth for the class-to-toggle mapping, instead of a private copy that named three of the seven mapped classes: `IfcSpatialZone`, `IfcVirtualElement`, `IfcGeographicElement` and 3D `IfcAnnotation` solids now follow their toggles in the embed the way they already did in the full viewer.

`PROTOCOL_VERSION` stays `'1.0'`, and neither side ever compares it, so nothing breaks on a mismatch. But do not read that as safe. A new SDK against an older viewer, which the `origin` option makes a supported deployment, gets a resolved promise and no effect for the four new flags: the same silent no-op this release exists to remove, moved to version skew. `READY` still reports `'1.0'`, so a host cannot feature-detect either. Publish the embed before the SDK. Making the skew detectable needs a version bump, which changes the literal type of every envelope, so it is a separate decision.

The bridge test now pins the protocol list against the store's `TypeVisibility` at runtime (same key set) and at compile time (every protocol key is a store key, and no store key is missing), so the two cannot drift apart again.

Two behaviour notes for existing embeds, because both are visible and neither produces an error.

`IfcSpatialZone` and `IfcVirtualElement` had no gate at all in the embed's private mapping, so they rendered whatever the toggles said. They now follow `spatialZones` and `virtualElements`, which default to off (`IfcVirtualElement` off since #1133, because non-physical clearance volumes obscure real geometry). An embed that never sends `SET_TYPE_VISIBILITY` and was showing gross-area zones or clearance volumes will stop showing them. That is the fix doing its job, and it matches the full viewer, but it is a change you did not ask for. To keep the old rendering, send `setTypeVisibility({ spatialZones: true, virtualElements: true })`.

`site` changed meaning too, and it is the one flag that already existed, so this reaches hosts using today's API. It gated `IfcSite` alone; through the shared mapping it now also gates `IfcGeographicElement`, the modelled terrain that #1480 paired with it. A dashboard sending `site: false` to drop the site plate now loses terrain with it.

Defaults are also not a stable starting point. The embed shares the viewer's store, whose initial toggle state comes from `localStorage` on the embed's own origin, and every `SET_TYPE_VISIBILITY` persists back to it. So a returning visitor can start from their last session rather than from the defaults, and because every embed is served from one origin, that state is not scoped per host. This is how the three previous flags already worked; there are now seven of them. A host that needs a deterministic starting state should send `setTypeVisibility(...)` on every load rather than relying on defaults.

Not fixed here, and adjacent enough to name: the embed still re-multiplies `IfcSpace` and `IfcOpeningElement` alpha down to 0.3 in the same filter chain, which `ViewportContainer` dropped under #677 because it stomped explicit colour choices. The clamp lives in a React memo, so it bites whenever geometry is uploaded from that mesh list: the initial load, a model swap, colours that arrive while streaming is still running, and any type-visibility toggle, which re-uploads the visible set. The sequence that reproduces it is colour a space, then turn spaces on, and the space comes back at 0.3. A colour sent after load is not affected, because `SET_COLORS` also queues `pendingMeshColorUpdates` and that reaches `scene.updateMeshColors` directly while the geometry effect early-returns on an unchanged mesh count. It predates this change and needs its own diff.
