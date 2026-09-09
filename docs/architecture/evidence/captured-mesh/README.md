# Captured mesh native authoring (#4380)

This foundation authors an already segmented triangle surface into an existing
IFC model. It does not establish the capture import UI, segmentation, automatic
classification, reconstruction, or a browser end-to-end Save workflow.

The public real-file oracle uses [Boulder 01 by Rico Cilliers / Poly Haven](https://polyhaven.com/a/boulder_01),
CC0, with 67,042 source position/UV rows and 66,122 triangles. The pre-existing
capture adapter converted glTF Y-up to IFC Z-up `(x, -z, y)`, raised minimum Z to
zero, and converted texture V to IFC V-up. It retained full triangle topology and
the original 1K diffuse JPEG. No Python IFC writer is part of this implementation.

Reproduce with `IFCLITE_CAPTURED_MESH_FIXTURE` pointing to the adapter's
`boulder.json`:

```sh
IFCLITE_CAPTURED_MESH_FIXTURE=/path/to/boulder.json cargo test -p ifc-lite-processing appearance::captured --lib -- --nocapture
IFCLITE_CAPTURED_MESH_FIXTURE=/path/to/boulder.json TEST_SHARDS=1000003 TEST_SHARD=179174 pnpm test --filter=@ifc-lite/viewer --env-mode=loose
```

The native oracle authors the real mesh, applies its entity plan to an IFC
snapshot and loads it through `process_geometry`. It compares each triangle's
world-space corners and associated UV corners, with a 1e-6 metre / UV tolerance.
The ordinary importer can weld vertices differently from the isolated canonical
product planner; it produced 196,855 vertices while retaining all 66,122 faces.
Vertex-array identity would incorrectly reject this valid representation.

The actual WASM oracle checks every authored corner against the source capture
(1e-4 metre and 1e-6 UV refusal tolerances), the owner and geometry-item identity,
and the retained JPEG URI. A second small non-planar mesh has an intentional UV
seam, and exercises the real worker route, stale allocator rejection and
cancellation. Native tests additionally cover rotated millimetre containers,
5,000-km georeferencing, IFC4X3 entity slots, malformed indices and degenerate
triangles. These tests establish image correspondence; actual image decoding,
GPU rendering, host history and portable export are downstream acceptance.

Input fingerprints:

- Derived `boulder.json`: SHA-256 `2dfa4e3b07dc138ba82317c09b60b41bd40feacf62f2025409b50d2fef569752`.
- Original diffuse JPEG: SHA-256 `c38f0e918f6dc16b8d386ba3cdd89805c78320c119a1ceec85856f82b09a65b8`.
- Tested generated WASM: SHA-256 `498146de2117229de433704e94ceb2cd9dce6358d79ad5b78eb5d61abfe037b3`.

[Native ordinary-load smoke samples](native-load.json) compare the exact base
and branch source on AC20-FZK-Haus. Counts are unchanged; quantization, noise and
lack of an exclusive idle-machine window make timing inconclusive. This is not a
browser worker-pool or capture-creation performance claim.

Adversarial review also runs the required four in-tree IfcOpenShell parity
comparisons with a wheel rebuilt from this branch: all four match (the existing
triangle-density advisory remains). The worker client refuses oversized capture
row arrays before worker allocation or structured cloning; the native planner
independently validates geometry, indices, numeric bounds and image coordinates.
