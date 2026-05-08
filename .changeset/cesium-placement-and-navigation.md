---
"@ifc-lite/viewer": patch
---

Cesium overlay: precomputed terrain placement, ground-floor clamping,
and a refactored camera path.

**Placement is now resolved before the bridge is built** (no more
"model loads at IFC OrthogonalHeight, then jumps to terrain"):

- `terrain-elevation.ts` (new module) tries sources in fast-first
  order — sync `globe.getHeight`, sync `scene.sampleHeight`, async
  `scene.sampleHeightMostDetailed` with a 3.5 s timeout, then
  Open-Meteo as a bare-earth fallback. Implausible elevations
  (e.g. depth-buffer noise from Google Photorealistic 3D Tiles
  returning `-69184 m`) are range-checked against terrestrial bounds.
  Results are cached per-session via `clearTerrainElevationCache()`.
- `sampleHeightMostDetailed` runs *before* Open-Meteo so the model
  lands on the same surface the user actually sees in 3D Tiles
  (street decks, podiums) rather than the bare-earth DEM.
- `createCesiumBridge` accepts a `placementHeightOverride` so the
  computed placement is baked into the `enuToEcef` origin altitude
  for both camera frame and model matrix from creation.

**`findClampAnchorY` (new helper, 9 unit tests)** picks the anchor
viewer-Y that auto-clamp pins to terrain. Primary: the
`IfcBuildingStorey` whose elevation is closest to 0 (ground floor),
within the model AABB. Fallback: `bounds.min.y`. Without this,
basements and foundations dragged the model deep below the terrain
surface.

**`oHeightForBaseAltitude`** in the Georeferencing panel now mirrors
the auto-clamp formula (anchor-aware, shift- and RTC-aware), so the
"Set OrthogonalHeight to Cesium terrain elevation" button produces
the same world position as toggling the clamp.

**UX behaviours**

- `cesiumTerrainClamp` defaults to `true` (slice + reset path).
- Clamp toggle is now actually uncheckable — dropped the auto-toggle
  branch that fought the user's setting.
- Editing OrthogonalHeight directly auto-releases the clamp so the
  edit takes effect (with clamp on, placement is intentionally
  terrain-anchored regardless of OrthogonalHeight).
- Stale `terrainHeight` / `terrainClipY` are cleared when a re-query
  fails so the clip plane doesn't drift relative to the new bridge.
- Effect 2d depends on `bridgeVersion` so the model matrix refreshes
  after an async bridge rebuild.

**Camera navigation refactor.** Reported symptom: orbit/zoom
restricted to the terrain plane. Two coupled root causes:

1. `screenSpaceCameraController.enableInputs` was still default-true.
   Any input slipping past the overlay's `pointer-events: none`
   reached Cesium and got processed in the locked frame, fighting
   our externally-driven pose. Now flipped to `false` (master kill-
   switch) on top of the per-mode flags.
2. `syncCamera` used `lookAtTransform(viewerToEcef)` to write
   position/direction/up in viewer-space. `lookAtTransform` *locks*
   Cesium's reference frame; rotate/tilt/zoom operations are then
   constrained to that local frame — the "stuck to terrain plane"
   behaviour. Refactored to clear `lookAtTransform` with
   `Matrix4.IDENTITY` and write position/direction/up directly in
   ECEF (Cesium's RTC handles shader precision for primitives).

**Network hygiene.** `queryTerrainElevation` (Open-Meteo) gets a 5 s
`AbortController` timeout and a `console.warn` so failures are
visible instead of silently swallowed.
