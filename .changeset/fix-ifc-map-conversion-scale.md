---
"@ifc-lite/viewer": patch
---

Apply IfcMapConversion.Scale per IFC schema (issue #595).

Scale converts local engineering coordinates (in the project length unit)
to map CRS units (e.g. `0.001` for a millimetre project with a metre map).
ifc-lite's geometry pipeline already converts vertices to metres during
extraction, so applying the raw Scale to viewer-space coordinates double-
scaled the model — making the Cesium 3D world context unusable for files
authored per spec.

Introduces `getEffectiveHorizontalScale(scale, mapUnitScale, lengthUnitScale)`
which returns `(scale × mapUnitScale) / lengthUnitScale` — the correct
multiplier for metre-converted geometry. For files where Scale is set
consistently with the unit difference this evaluates to 1.0 and the
geometry passes through unchanged. Wired through:

- `cesium-bridge.ts` — 3D model origin and the viewer→ENU rotation.
- `CesiumOverlay.tsx::buildModelMatrix` — GLB placement.
- `reproject.ts` — 2D map centre, footprint, and reverse-pick.
- `useIfcFederation.ts` — multi-model alignment transform.

Adds a visible amber warning in the Georeferencing panel when
`Scale × mapUnitScale ≠ lengthUnitScale` (the IFC schema invariant) so
authoring errors are discoverable. The warning surfaces both inline (in
the expanded Coordinate Operation section) and as a small indicator on
the collapsed section header.
