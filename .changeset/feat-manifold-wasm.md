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
