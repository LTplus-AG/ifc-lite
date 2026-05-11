---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": minor
---

Near-term UX features from #611.

**Hover XYZ readback.** GPU pick now also samples the depth texel at
the click position and unprojects it through the inverse view-
projection. `PickResult` carries an optional `worldXYZ`. Reverse-Z is
honoured (depth=1 = near, 0 = far / miss). The hover tooltip shows
`x, y, z` (2 decimals) under the entity id. Useful for measurement
hooks and point-cloud picks where the synthetic entity has no
surface property to display.

**Solid-color picker.** When the point-cloud panel's colour mode is
set to `fixed`, a native `<input type="color">` swatch appears.
Hex round-trips through the existing `[r,g,b,a]` store tuple.

**Colour-mode legend.** A new `PointCloudLegend` component renders
inline beneath the colour-mode buttons:
- Classification → list of ASPRS LAS 1.4 class id / colour swatch /
  label (Ground, Vegetation, Building, ...). Palette mirrors
  `point-shader.wgsl.ts` exactly.
- Intensity → black-to-white gradient bar with low/high labels.
- Height → cool-warm gradient bar (blue → cyan → green → yellow →
  red), matching the shader's `height_ramp`.
RGB and Solid don't render a legend.

**Cancel button for in-flight streams.** New
`activeStreamCanceller` field on the loading slice. Both ingest
sites (`useIfcLoader`, `useIfcFederation`) register
`() => streamHandle.cancel()` after starting and clear on success /
error. `StatusBar` shows a Cancel button while the canceller is
non-null. AbortError on cancel is reported as "Cancelled" rather
than a scary error string.
