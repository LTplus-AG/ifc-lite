---
"@ifc-lite/server-bin": minor
"@ifc-lite/server-client": minor
---

Surface georeferencing and the length-unit scale from the Server's geometry
endpoints, continuing the `@ifc-lite/parse` parity work (issue #900).

The browser parser exposes `IfcMapConversion` / `IfcProjectedCRS` georeferencing
(`extractGeoreferencing`) and the length-unit scale (`extractLengthUnitScale`),
but the server returned only a coarse `is_geo_referenced` boolean and kept the
unit scale internal. Both are now carried inline on `ModelMetadata`, so they
reach **every** geometry endpoint at once (JSON, SSE, Parquet, optimized Parquet,
and the cached-geometry paths) — no new endpoint or fetch round-trip.

Server (shipped in the `@ifc-lite/server-bin` binary):

- `ModelMetadata` gains `length_unit_scale: Option<f64>` and
  `georeferencing: Option<Georeferencing>` (CRS name / geodetic + vertical datum
  / map projection, false eastings/northings, orthogonal height, X-axis
  direction, scale, derived grid-north `rotation_degrees`, and a column-major
  local→map `transform_matrix`).
- Georeferencing reuses the existing shared `ifc_lite_core::GeoRefExtractor`
  (the same extraction the native/desktop paths use, including the IFC2x3
  `ePSet_MapConversion` fallback) via a new `ifc_lite_processing::extract_georeferencing`.
- Populated in the shared geometry pipeline (`process_geometry_filtered`) and the
  server's streaming `Complete` event (extracted on a blocking thread).

Client (`@ifc-lite/server-client`):

- New `Georeferencing` type; `ModelMetadata` gains optional `length_unit_scale`
  and `georeferencing`.

Regression coverage: `rust/processing/tests/issue_900_georeferencing_metadata.rs`
asserts a georeferenced metre model surfaces the CRS + offsets + rotation and a
millimetre model reports `length_unit_scale = 0.001` with no georeferencing, plus
unit tests in `georeferencing.rs`.
