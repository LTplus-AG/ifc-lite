---
'@ifc-lite/wasm': patch
---

`ClippingProcessor`'s four boolean-op accept paths (`subtract_mesh`, `subtract_mesh_many`, `union_mesh`/`union_meshes`, `intersection_mesh`, in `rust/geometry/src/csg/`) validated a kernel result for finiteness and index bounds only, so a torn (non-manifold / open-edge) result was accepted and shipped silently — issue #3440. A prior change added a non-gating diagnostic record for this (`BoolFailureReason::KernelError`, informational only, still shipped in every build). This adds the second step the issue prescribes: a REJECT signal, but gated behind a new, off-by-default `csg_topology_gate` Cargo feature that no downstream crate enables — not `debug_geometry` / `csg_capture` / `observability`, which the native server already turns on in production, so wiring a behaviour change through any of those would have flipped real hosts today.

Without the feature this is a no-op with no measurable cost: the gate function's default-build body never runs the closure predicate, it only returns `false`. With `--features csg_topology_gate` (a `cargo test`/`cargo build` opt-in for CI or census measurement) a torn result is rejected the same way an existing `KernelOutputInvalid` result already is — falling back to the un-cut host / an empty mesh / a plain merge — and records the new `BoolFailureReason::OpenTopologyRejected` reason through the same `take_csg_failures` / per-host diagnostics channel the informational record already used.

Reuses `directed_closed` / `closed_or_hairline` (`router/voids/prism_cut/closure_checks.rs`) — the analytic prism-cut path's own accept/reject predicate — rather than adding a fourth definition of watertightness to the crate, per the issue's explicit direction.

Not on any default or production build path: `ifc-lite-wasm`'s own feature set does not enable `csg_topology_gate`, so this ships no observable change to `@ifc-lite/wasm` consumers. Flagged as a patch because it is a new, currently-inert opt-in surface on the underlying Rust crate that this package's release process versions together.
