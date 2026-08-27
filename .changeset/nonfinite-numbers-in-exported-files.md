---
"@ifc-lite/wasm": patch
"@ifc-lite/drawing-2d": patch
---

Stop writing `NaN` / `Infinity` / `-Infinity` into exported GLB, COLLADA, KMZ and SVG files.

Neither format can carry a non-finite number, and every one of these paths wrote one anyway.

**GLB / COLLADA / KMZ** (`export_glb_from_meshes`, `export_collada_from_meshes`, `export_kmz_collada_from_meshes` — the viewer's "export" buttons, via `GeometryProcessor.exportGlbFromMeshes` / `exportKmzFromMeshes`). Nothing between a mesh buffer and the bytes established that a coordinate was finite, and the three values did not fail alike:

- An infinite position made `serde_json` write `null` where glTF requires a number — `"min":[null,-0.5,0.0]`, `"translation":[null,0.5,0.0]` — which is schema-invalid, so the whole GLB is rejected rather than merely wrong.
- A `NaN` position reached the BIN chunk while `min`/`max` stayed finite, because `NaN < min` and `NaN > max` are both false. The accessor's bounding box described a buffer it did not contain.
- COLLADA re-centres on the mesh AABB, so **one** non-finite vertex turned **every other vertex in the document** into `inf`/`NaN`. Observed: a triangle whose first X was `-Infinity` came out as `NaN 0 0 inf 0 0 inf 0 1` — one bad vertex, no surviving geometry. `<float_array>` is `xs:float`, whose non-finite lexical forms are `INF`/`-INF`/`NaN`; Rust's `Display` writes `inf`/`-inf`, which are not even those.
- A non-finite colour component became `"baseColorFactor":[null,0.5,0.5,null]`.

All four float arrays (positions, normals, colours, per-mesh origins) now pass through one gate, `mesh_input::scrub_nonfinite`, before either exporter's per-mesh loop reads any of them — rather than at each of the several points where a value becomes bytes, where a guard reaches three call sites out of four. A non-finite component is replaced with `0.0`, matching what the USD writer already did; alpha is the exception and becomes `1.0`, since scrubbing it to `0` would turn a colour defect into an invisible mesh. An all-finite input — the only case a well-formed model produces — is passed through borrowed, with no copy and byte-identical output.

**SVG** (`exportToSVG`). SVG's `<number>` grammar admits a sign, digits, a point and an exponent and nothing else, so `x1="NaN"` is an error a conforming renderer must not draw. Thirteen coordinate, size and rotation interpolations went through a bare `.toFixed(3)`, which stringifies all three values verbatim; the DXF writer beside it in the same package has guarded exactly these at its single `fmt()` since it was written, so the two writers of the same drawing disagreed about the same input. Every SVG number now goes through one `svgNum()`. Separately, `computeTransform` derived the paper offsets from `boundsCenter`/`boundsSize`, which are plain min/max arithmetic: one non-finite corner of the bounding box moved every finite line in the drawing (a line that belonged at `x1="190.000"` was written as `x1="NaN"`). The bounds are sanitised before anything is derived from them, so a degenerate corner no longer relocates the rest of the drawing.
