---
'@ifc-lite/drawing-2d': patch
'@ifc-lite/export': patch
---

Check the glTF, COLLADA and DXF exporters against the formats, not against our
own readers.

Test-only; no exporter behaviour changed. Three export formats had no external
validator and no third-party fixture anywhere in the repo: the only reader of a
GLB we write was our own `parseGLB`, the only reader of a DXF we write was our
own `parser.ts`, and COLLADA had no reader at all — every assertion was a
substring of the output. A writer and a reader that agree with each other prove
they share a convention, not that the convention is the format.

- **glTF** — `scripts/test-wasm-contract.mjs` now runs the Khronos
  glTF-Validator (`gltf-validator`, the reference implementation, pinned exact)
  over the GLBs the real wasm exporter produces on both entry points, failing on
  errors *and* warnings, plus a guard that the validator saw actual geometry so
  a silently-empty export cannot pass vacuously. It reports 0 errors and 0
  warnings on today's output. `rust/export/src/gltf_conformance_tests.rs` adds
  the spec rules that lane cannot reach (`quantize`, the bounded/streaming
  assembler and the multi-buffer path have no wasm binding): accessor TOTAL
  byteOffset alignment, declared `min`/`max` recomputed from the bytes actually
  written, index values against the primitive's own vertex count,
  `mode`/`componentType` legality, and the GLB chunk framing and padding bytes.
- **COLLADA** — `rust/export/src/collada_conformance_tests.rs` checks the
  document's internal agreement: `count=` attributes against the data they
  introduce, every `#reference` resolving to a declared `id`, `<p>` indices
  inside the accessor they index, and `<input offset>` against the `<p>` stride.
  An out-of-range `<p>` index leaves all eleven pre-existing COLLADA tests green.
- **DXF** — `packages/drawing-2d/src/dxf/writer-interop.test.ts` reads the
  writer's output back with `dxf-parser` (npm, MIT), an unrelated third-party
  reader, and separately pins the raw group codes against the R12 rules a
  lenient reader never needs: POLYLINE's `66` vertices-follow flag, the TEXT
  alignment point `11/21/31` that must accompany a non-zero `72`/`73`, section
  balance, and the absence of any post-R12 group code. Dropping the alignment
  point leaves all 74 other DXF tests green.

Every check was mutation-proved: the writer was broken, the check was confirmed
to fail, and the writer was restored.
