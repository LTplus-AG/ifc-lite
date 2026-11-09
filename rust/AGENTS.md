# Agent notes: rust/

Supplements [root AGENTS.md](../AGENTS.md).

- **Workspace:** edit repo-root `/Cargo.toml` (profiles: `release` aborts, `server-release` unwinds; version; shared lints); there is no `rust/Cargo.toml`.
- **Workspace tests exclude `rust/python` and detached `rust/csg-thread-bench`.** Test them separately on public-API changes.
- **150-line functions are ratcheted** (`function_length_ratchet`): a new or growing one fails; split it, and lower or delete its allowlist row as it shrinks.
- **No numeric clippy rewrites:** preserve the root allowances (`excessive_precision`, `manual_range_contains`, `manual_clamp`, `neg_cmp_op_on_partial_ord`, `approx_constant`); rewrites change NaN/panic behavior or intentional literals.
- **Canonical leaves/placements:** `EntityDecoder::{point3, direction3}[_at]` reads 2–3 finite numbers (2D z=0; malformed input counts refusals). Use `ifc_lite_geometry::placement::{Axis2Placement, resolve_chain, resolve_object_placement, validate_chain}`. Keep consumer refusal policies; no component defaults or duplicate `PlacementRelTo` walks.
- **Representations:** use public `representation::RepresentationWalk`; `Select::Meshed` is what renders. Lenient probes use public shallow ID helpers; geometry reuses admission/`unwrap`. Never hand-walk attributes 6 → 2 → 3.
- **Closure/volume (`rust/geometry`; tests via `test-support`):** use `mesh_check`'s `EdgeLedger` and named `VertexKey`/`Degenerate` policies; no local edge-pairing maps.
- **Float sort keys: `ifc_lite_geometry::cmp_f64_nan_last`** (NaN last, `-0.0 == +0.0`), not `partial_cmp(..).unwrap_or(Equal)`, which may panic a sort on NaN. `scripts/check-float-sort-comparators.mjs` flags every other non-test `partial_cmp` (#7674).
- **`[lints]` inherit-vs-extend footgun.** core/processing/clash/ffi/export/wasm-bindings use `[lints] workspace = true`, but `rust/geometry` instead carries a full `[lints.clippy]` block (a member cannot inherit and extend); for a local allow elsewhere, do the same.
- **RTC is orchestrator-owned:** `detect_rtc_offset_for_file` + `router.set_rtc_offset` in `processing/src/processor/resolve/frame.rs`. Direct router callers must set the offset for models beyond `LARGE_COORD_THRESHOLD_METERS` (1 km). Restore world coordinates through `ProcessingResult::frame` (`MeshFrame::to_world`/`world_matrix`) in f64; never re-derive the site tier or add RTC in f32 (#7684).
- **STEP strings:** `decode_ifc_string` handles `\X\ \X2\ \X4\ \S\ \P\`; malformed `\S\` before a multibyte character must not panic (#1500). Keep `s_escape_before_multibyte_char_does_not_panic` green when changing `decode_ifc_string` (`core/src/step_encoding.rs`).
- **Diagnostics:** use `diag_warn!`/`diag_debug!` (`geometry/src/diag.rs`), never kernel `eprintln`. `observability = ["dep:tracing"]` routes them through tracing (server: `ifc-lite-processing/observability`); feature-off output stays byte-identical with zero tracing code. `csg_capture`/`debug_geometry` are opt-in.
- **Toolchain:** use repo-root `/rust-toolchain.toml` (CI pin). Never add `rust/rust-toolchain.toml`: it shadows the pin (#2834).
- **Void-cut order** lives only in `HOST_STAGES`, `cut_in_frame`, `ExactTail::run`, `post::finish`; extension rule: `docs/architecture/mesh-determinism.md#frozen-void-cut-order`.
- **Kernel booleans:** `subtract[_many]` / `union[_many]` / `intersection` (`geometry/src/kernel/mesh_bridge.rs`). Group cuts go through `ClippingProcessor::subtract_mesh_many` (`geometry/src/csg/group_cut.rs`).

**G3 (#7779):** CI's `check-leaf-reader-copies.mjs` rejects copied production leaf spellings except canonical readers; it masks comments/literals/tests/simple `cfg(test)`, scans compound cfg, and runs synthetic controls. Zero hits prove spelling, not parity.

- **Pipeline:** call `ifc_lite_processing::process(content, &ProcessingRequest, sink)`, never add `process_geometry_*` variants. Pass inputs are request fields; output streams are sink events.
- **Discovery, arming, production:** see the root file's Geometry & WASM section (`ScanClass`, `TypeGeometryPlan`, `produce_element_meshes_owned`).
