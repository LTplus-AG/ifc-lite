# Collaboration georeferencing regression #6499

Real Chrome/SwiftShader run of `collab-georeference.e2e.spec.ts`, using the committed SketchUp 2024 export `apps/viewer/public/samples/building-architecture.ifc` and an isolated signed collaboration relay. The latest production viewer build and root typecheck passed before this run.

`guest-world-card.png` shows **View → Context → World**, EPSG:32760, and millimetre project units after sharing. SwiftShader can discard compositor pixels, so this screenshot's empty viewport is not a geometry-rendering witness. `owner-renderer.png` and `guest-renderer.png` instead come from the production renderer's GPU color readback; both show the actual house. The one-model owner and fresh/rejoined guests also resolve an ordinary viewport click to the correct model and report resident GPU geometry and draw calls.

`facts.json` records one- and two-model fresh joins and fresh rejoins. Both slots retain the owner's coordinate frame, representative resident mesh points, project units, and CRS/map conversion. A live owner Eastings edit reaches the connected guest without changing the room's entity document and survives a fresh rejoin. Resource IDs are zero on dense reconstructed stores. Slot/model identifiers and frame timestamps have been removed from the evidence.

The two-model case checks spatial transport rather than isolated raster visibility: two identical overlapping source copies hit a pre-sharing visibility-oracle limitation. The numeric Yjs tests separately exercise distinct nonzero RTC/origin frames for both models and compare their projected coordinates through the canonical consumer. These captures prove local viewport rendering and restored World availability, rather than Cesium tile loading or an external globe screenshot.

Older rooms without spatial metadata cannot recover an unknown owner RTC frame; their owners need a new share from the original source. This additive slot metadata does not establish a portable root-only IFCX file export contract.
