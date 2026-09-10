# Unmerged chart-padding capacity experiment (#4381)

This branch is a negative experiment, not a release candidate. Do not merge its
runtime as a completed full-model transfer fix.

The mechanism differs from earlier query-only experiments: transfer interior
texels keep their exact surface observation; chart padding copies the nearest
same-chart interior texel in Manhattan distance. Unknown interior colours remain
seeds, and charts with no interior retain their existing target appearance.
Page/image projection keeps its original shader. A nearest-band BVH query is
combined with this in the final variant, without the earlier memo cache.

The original fixed 64,000,000 work and 256 MiB memory caps remain. Padding reserves
five additional scratch bytes per atlas pixel and charges two additional bounded
pixel visits (seed classification and propagation), consistent with the existing
one-unit raster-pixel accounting. The four-neighbor loop is fixed work within one
visit, like the existing fixed bilinear sampling operations. An earlier overly
conservative variant charged all neighbor checks separately (seven units per
pixel); it refused before raster sampling, because the unchanged source-fidelity
atlas has 9,535,488 pixels. The final three-visit accounting still exhausts the
BVH work budget and returns no plan. No quota increase or speedup is claimed.

Reproduce on the preserved input directory containing `source.ifc`, `request.json`
and `rgba.bin` from the nearest-query experiment:

```sh
cargo run -p ifc-lite-processing --example transfer_guard_probe -- /tmp/transfer-nearest-input
```

The IFC SHA-256 is
`0efc7987670ddb1287cb88fe1b9a239da754f41170e9420bf04293c0c54f34e3`.
The input retains all 66,122 source triangles and the complete selected 40,087
triangle target. Atlas density is 16 texels/metre, with the existing higher
source-texture fidelity floor unchanged. This is a same-source control, not
independent scan registration. The debug probe ran alongside other builds;
its elapsed field is deliberately not performance evidence.

Validation: 84 native appearance tests and two independent nearest-band tests
passed; strict workspace/all-target clippy passed. No full-workspace test,
WASM/browser acceptance, or full-model applicable output is claimed. The padding
invariants verify unchanged interior texels, retained unknowns, deterministic
nearest-seed ties, preserved subpixel appearance and no cross-chart writes.
The changed transfer digest distinguishes the experimental raster algorithm.

Lesson: removing guard-point queries alone does not establish full-target
capacity. The source-fidelity atlas and remaining interior correspondence work
must be handled together; repeating this combination unchanged is not progress.
