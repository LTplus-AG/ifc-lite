---
"@ifc-lite/wasm": minor
---

Replace the in-tree BSP CSG kernel with Manifold (elalish/manifold) in
the wasm build, matching the native path. Fixes the `RangeError: too
much recursion` / `unreachable executed` failures on degenerate IFC
geometry (notably issue #841 House.ifc) at the cost of ~250 KB added
to the wasm bundle.

The previous status — Manifold blocked on `wasm32-unknown-unknown` by
upstream `wasm-cxx-shim` libc++ issues — was resolved in
`wasm-cxx-shim` v0.5.0 / `manifold-csg-sys` 3.5.100 (May 2026). Flip
`rust/wasm-bindings/Cargo.toml` to depend on
`ifc-lite-geometry/manifold-csg-wasm-uu` and provision the
cross-toolchain on Vercel via `scripts/vercel-install.sh`:

- `dnf install clang20 lld20 cmake` from AL2023.
- Fetch matching `libcxx-N.N.N.src.tar.xz` headers from the LLVM
  release page; cached under `/vercel/cache/wasm-cxx/` so subsequent
  deploys reuse them.

Local dev: `brew install llvm lld` on macOS, `apt install clang-20
lld-20 libc++-20-dev libc++abi-20-dev` on Debian/Ubuntu. The
wasm-cxx-shim toolchain file auto-detects standard install paths.

`docs/architecture/geometry-pipeline.md` updated to reflect the new
status, build prerequisites, and runtime properties (single-threaded
on wasm, no exception runtime).

Same correctness as the native Manifold path; wasm bundle grows from
~1.5 MB to ~1.7 MB after the existing `wasm-opt -O3` pass.

## Post-process for visual quality

Manifold's raw output splits previously-single coplanar faces into
many adjacent strips along the cutter boundary, and the verts on
those strip boundaries are emitted as distinct (numerically
near-coincident) topological points. Shipping that to the renderer
as-is gave two visible artefacts on the PR's first deploy preview
(`02_BIMcollab_Example.ifc`):

1. **Scar lines on coplanar surfaces** — visible horizontal striations
   on walls / slabs / roofs where adjacent strips had slightly
   different vertex normals after per-vertex averaging.
2. **Stretched sliver triangles** — long red "rays" shooting out of
   the building from rare boundary-intersection degenerate
   triangles.

`manifold_to_mesh` now does a post-process pass:

- Compute initial per-vertex face normals.
- `Mesh::welded(1 µm position, 1 mrad normal)` — collapses pure
  numerical-noise duplicates while preserving crisp corner verts
  (perpendicular faces meeting at a point have distinct normals and
  stay separate).
- Re-derive area-weighted normals on the welded mesh.

The 1 µm tolerance is file-unit-relative (the CSG runs on the router's
pre-scaled mesh) so it's safe for both metre and millimetre IFCs. An
earlier attempt at the broader `Mesh::welded_by_position` collapsed
legitimate distinct verts on rounded sanitary geometry and regressed
`bath_csg_solid_test::subtracted_a_cavity` from ~0.55 m³ to 0.0326 m³;
the normal-aware variant keeps the bath intact.

Follow-up scope: a crease-angle smooth-group pass would make hard
corners (wall-meets-floor) shade crisply while keeping coplanar
surfaces uniform. The current post-process softens those corners
slightly because position-only welding can't tell a real corner
vertex from a numerical-noise duplicate without the normal-eps gate,
and the gate's threshold is too tight to catch all the noise on
boundary-coincident input.
