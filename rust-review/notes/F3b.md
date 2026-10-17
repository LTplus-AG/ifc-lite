## F3b design note (coordinator b61983f5)

Work package F3b (#7779, charter #7670): core entity reading. That covers points and directions, `IfcAxis2Placement2D/3D`, `IfcAxis1Placement` and the `ObjectPlacement` chain. The note is written against `origin/main` at `38577fa7f8`, with every file:line re-measured there. Two PRs are treated as landed: **#7752 (S6a)**, which adds the admission counter, `Error::UnrepresentableReal`, `Transform2D::refused()` and `with_strict_reals`, and **F2a G1** (`sweep/f2a-g1-math-home`), which adds `math::mat4::{from_na, col_major_array}` and lightly edits `router/transforms/{walk,mod,linear,grid_frame,mapped}.rs`. F3b's geometry PRs do not start until both have merged.

Findings closed: XCUT-1 (the placement half; F2a closes the math half), XCUT-2, XCUT-27, ROUTER-3, ROUTER-16, PROC-1, PROC-S7 (rest), PROC-S9, PROC-AL-10, GEOM-1, GEOM-2, GEOM-19, GEOM-28, PROCESSING-SYM-2, PROCESSING-SYM-6, PROCESSING-SYM-16, CORE-37. CORE-13 (the reader half) is re-mapped to F4 (§2.1).

### TL;DR of the decisions

1. **Split across two crates by what each one needs.**
   - **Core:** the leaf readers, as `EntityDecoder::{point3, direction3, point3_at, direction3_at, resolve_optional}`. They return `[f64; 3]` and refuse through a counted `Error::MalformedRecord`. Core owns the byte fast path and the admission counter, and every crate depends on core.
   - **Geometry:** everything that builds a frame or composes a chain, in a new `pub mod ifc_lite_geometry::placement`. That covers `Axis2Placement`, `Axis1Placement`, `build_axis2_matrix` (moved), `resolve_chain` / `resolve_object_placement`, `chain` and `validate_chain`, plus the Linear and Grid resolvers moved out of `router/transforms`. The frame math needs nalgebra and F2a's `math`, which sit above core. Every chain consumer (processing, export, wasm, server) already depends on geometry.
2. **One leaf rule.** The record must have the expected type (`IfcCartesianPoint` / `IfcDirection`), and attribute 0 must be a list of 2 or 3 `REAL`/`INTEGER` values, all finite.
   - 2 values promote to 3D with z = 0 (D26).
   - 0, 1 or 4+ values, a non-number, or the wrong type are **refused and counted** (D3).
   - Directions are returned as raw ratios and never normalised here.
   - This replaces today's three spellings: `unwrap_or(0.0)` on every component, z or x defaulted to `1.0`, and the type-agnostic fast path.
3. **Readable but degenerate stays repaired; unreadable is refused** (D25).
   - A zero-length Axis/RefDirection, or Axis parallel to RefDirection, is repaired by `build_axis2_matrix` exactly as today. That function is unchanged bit for bit, and the TS `firstProjAxis` parity pin still holds.
   - A missing mandatory attribute is refused: a `$` Location, a `$` `RelativePlacement`, or a non-placement in `PlacementRelTo`.
   - **Exception:** an IFC WR that makes a promoted or defaulted value meaningless refuses at the consumer. A revolved solid's axis must lie in XY, and an `ExtrudedDirection` needs a non-zero z.
4. **`resolve_chain` is iterative, with a visited set and no depth cap** (D27).
   - `PlacementRelTo` has fan-out 1, so AGENTS.md's "prefer iterative over a cap" applies directly.
   - The current cap combined with the memo makes the result order-dependent, which `walk.rs:20-28` concedes. Under D3 that would turn into nondeterministic element loss across thread counts.
   - A cycle refuses and is counted. Chains longer than 100 links now resolve in full ("equalise up", the direction `limits.rs` prefers).
   - The memo discipline (complete results only, unscaled, column-major) is kept, and the memo becomes a true pure function of the id.
5. **Each consumer keeps its own mapping from error to output.**
   - The mesh path refuses the element (counted). `$` ObjectPlacement stays identity: #2256's "genuinely missing" case.
   - Symbolic maps an admission/malformed refusal to `Transform2D::refused()` (D15, drop) and every other error to `unresolved()` (#2256, until C5).
   - Validators pass a `ChainPolicy`.
6. **Reconcile, then delete,** with one sanctioned exception, *adopt-as-X* (D28). When reconciling a fork in place would mean writing logic the home already has, or the site is a single call, the X PR adopts the home directly and changes nothing else. Examples: symbolic would need Grid/Linear/tilt support; the validators would need cap and kind rules. Every drift item still gets its own test. Every other fork is reconciled in place by an X PR, then deleted by an R PR that is byte-identical.
7. **There is one refusal counter.** S6a's `ProcessingStats.refused_input_elements` also counts F3b's malformed-leaf and placement refusals. The core accessor is named `refused_records()`. Ask #7752 to rename `refused_real_records` before it merges; otherwise F3b-C1 renames it under break #11 (D29).
8. **Semver:** core adds methods plus the `Error::MalformedRecord` variant. The enum is not `#[non_exhaustive]`, so that is a break. Geometry deletes six `pub` transform readers; the only external caller is `export/src/step_map_rigid.rs:124`. Both changes append to **break #11**.
   - These keep their signatures and bodies, and are not touched by F3b: `GeometryRouter::{resolve_scaled_placement, resolve_scaled_placement_strict, resolve_linear_placement_local_strict}` and `rotation_angle_about_z`.
   - The wasm surface is unchanged.
9. **16 PRs: 4 R (C1, R1, R2a, R2b) and 12 X.** Required for the stop line: C1, X1, X2, R1, X3a, R2a, P1, P2, P4, E1.

---

### 1. API

#### 1.1 Core: `rust/core/src/decoder/leaf_read.rs` (new, ~160 lines prod, `impl EntityDecoder`)

```rust
/// `IfcCartesianPoint` by id under the one leaf rule (see module doc).
/// Ok: 2 or 3 finite numbers (2 -> z = 0). Malformed -> counted `Error::MalformedRecord(id)`.
/// A dangling id -> the decode error, unchanged.
pub fn point3(&mut self, id: u32) -> Result<[f64; 3]>;
/// `IfcDirection` by id, same rule; raw ratios, not normalised, zero allowed.
pub fn direction3(&mut self, id: u32) -> Result<[f64; 3]>;
/// Attribute `slot` of `entity`: `$`, `*` or past the end -> Ok(None); `#n` -> point3(n);
/// anything else -> counted `MalformedRecord(entity.id)`.
pub fn point3_at(&mut self, entity: &DecodedEntity, slot: usize) -> Result<Option<[f64; 3]>>;
pub fn direction3_at(&mut self, entity: &DecodedEntity, slot: usize) -> Result<Option<[f64; 3]>>;
/// ROUTER-16: `$`/`*`/absent -> None, `#n` -> Some(decode), any other value -> counted refusal.
/// Replaces the "attr -> non-null -> resolve -> default" ladders and B6c's `resolve_present`.
pub fn resolve_optional(&mut self, entity: &DecodedEntity, slot: usize) -> Result<Option<DecodedEntity>>;
/// Count and return a malformed-record refusal (D3), as `refuse_record` does for reals.
pub fn refuse_malformed(&self, id: u32) -> Error;
/// Every record refused under admission: unrepresentable reals (#7752) plus malformed leaves.
pub fn refused_records(&self) -> u64;   // was `refused_real_records` in #7752 (D29)
```

- **`Error::MalformedRecord(u32)`** is a new variant with the message "Entity #{0} is malformed geometry input; refused".
- **Fast path:** `point3` and `direction3` first try the existing strict byte grammar (`parse_cartesian_point_inline`, made `pub(super)`), plus a case-insensitive keyword check after `=` using `skip_step_trivia` (#4497). Directions get a fast path for the first time, because `IFCDIRECTION((a,b,c))` has the same layout. On a fast-path miss, both fall back to `decode_by_id` and apply the rule to `AttributeValue::{Float, Integer}`. A typed wrapper inside a coordinate list is refused, matching the fast path. Today `as_float` accepts it.
- **F4 alignment.** F3b adds no grammar. When F4 reroutes `decoder.rs:716 parse_cartesian_point_inline` onto `StepRecord::point_at(0)` (F4 note §2.1), `leaf_read.rs` switches in the same edit to `StepRecord::parse(raw)?` for the keyword and `.point_at(0)` for the list. One parse serves both, and `point_at` serves directions too. There is no `direction_at`.
- `get_cartesian_point_fast` stays type-agnostic and is **not** a leaf reader. It remains the speculative probe for the RTC vote and the polyloop caches; those callers must not count refusals.
- Out of scope in core:
  - `model_bounds.rs` is a byte scanner with no decoder, so it moves onto F4's `StepRecord::point_at`.
  - The f32 coordinate-list helpers are covered by CORE-37 (§3, C2).

#### 1.2 Geometry: `rust/geometry/src/placement/` (new `pub mod placement`; each file < 400 lines, tests in siblings)

| File | Items | Notes |
|---|---|---|
| `mod.rs` (~220) | `pub struct Axis2Placement { pub location: [f64; 3], pub axis: Option<[f64; 3]>, pub ref_direction: Option<[f64; 3]>, pub planar: bool }` | `read(&DecodedEntity, &mut EntityDecoder) -> Result<Self, PlacementError>` dispatches on type (2D/3D) and refuses other types. `read_id(u32, ..)`, `read_3d(..)` (refuses 2D). `matrix(&self) -> Matrix4<f64>` = `build_axis2_matrix(location, axis.unwrap_or(+Z), ref_direction.unwrap_or(+X))`; a 2D placement passes `axis = +Z`. `rotation_angle_about_z` moves here (root re-export kept, AGENTS.md:65). |
| | `pub struct Axis1Placement { pub location: [f64; 3], pub axis: Option<[f64; 3]> }` | `read(..)`, `axis_or_ifc_default() -> [f64; 3]` (the IFC derived default +Z). A consumer whose WR forbids the default refuses on `None` itself. |
| | `pub(crate) fn build_axis2_matrix` | Moved verbatim from `transform.rs:78`, doc fixed (it is the *only* orthonormalisation; there are no forks left). |
| `chain.rs` (~260) | `pub fn resolve_chain(&DecodedEntity, &mut EntityDecoder) -> Result<Matrix4<f64>, PlacementError>`; `pub fn resolve_object_placement(product, decoder) -> Result<Option<Matrix4<f64>>, PlacementError>` (Ok(None) iff ObjectPlacement is `$` or absent); `pub fn chain(..) -> Result<SmallVec<[Link; 8]>, PlacementError>` (leaf-first `Link { id, kind: LinkKind::{Local, Linear, Grid} }`, cycle-checked, no transforms); `pub fn validate_chain(.., &ChainPolicy) -> Result<(), PlacementError>` | The output is **unscaled** (file units, the memo's unit). The caller scales: the router's `scale_transform`, or symbolic's `unit_scale`. One private `fn step(placement) -> Result<Step>` holds the per-kind "parent + local" rule, and all three walks use it, so the `PlacementRelTo` / grid-owner logic exists once (ROUTER-16's `parent_walk`). |
| `linear.rs`, `grid.rs`, `grid_frame.rs` | moved from `router/transforms/` as free `pub(crate)` fns | They use no router state (checked: only `self.parse_*` and `self.get_placement_transform_with_depth`, which become `placement` calls). `resolve_linear_placement_local_strict` stays a `pub` router method that delegates here. |

```rust
#[derive(Debug, thiserror::Error)] #[non_exhaustive]
pub enum PlacementError {
    Cyclic { at: u32 },                       // counted
    Unsupported { at: u32, found: IfcType },  // non-placement parent / non-Axis2 relative; counted
    Missing { at: u32, attr: &'static str },  // `$` mandatory Location / RelativePlacement; counted
    Policy { at: u32, rule: &'static str },   // validate_chain only; not counted (a consumer's limit, not bad input)
    Decode(#[from] ifc_lite_core::Error),      // dangling id, UnrepresentableReal, MalformedRecord
}
impl PlacementError { pub fn is_admission_refusal(&self) -> bool; } // Decode(UnrepresentableReal|MalformedRecord) | Missing — the D15 split
pub struct ChainPolicy { pub grid: bool, pub linear: bool, pub planar_relative: bool, pub strict_spatial: bool }
```

- `strict_spatial` is the alignment and export-preflight rule: exactly 3 coordinates, non-zero directions, and Axis not parallel to RefDirection (cross ≤ 1e-12). It is expressed once, in `validate_chain`.
- **Visibility:**
  - `pub`: `Axis2Placement`, `PlacementError`, `ChainPolicy`, `resolve_chain`, `resolve_object_placement`, `chain`, `validate_chain`. Processing, export and wasm consume them.
  - `pub(crate)`: `Axis1Placement`, since only geometry consumes it, and `build_axis2_matrix`.
  - Cross-crate callers wanting arrays use `math::mat4::from_na`. Nothing new speaks nalgebra beyond the `Matrix4` geometry already re-exports (`lib.rs:145`).
- **`lib.rs`:**
  - The module-visibility comment goes from 9 public modules (after F2a) to 10.
  - `pub use transform::{parse_axis2_placement_3d, …}` (`:286-290`) is deleted in R2a, and `transform.rs` is deleted with it.
  - `rotation_angle_about_z` is re-exported from `placement`.

#### 1.3 Semver and rust-major-offset

| Crate | Change | Account |
|---|---|---|
| core | + methods; + `Error::MalformedRecord` (breaking: `Error` is exhaustive); `refused_real_records` → `refused_records` if #7752 has merged | append to break #11 (C1) |
| core | `AttributeValue::parse_coordinate_list_{2d,3d,3d_f64}` return `Option<Vec<_>>` (CORE-37) | break #11 (C2) |
| geometry | + `placement` (additive, R1); − `parse_axis2_placement_3d`, `parse_axis2_placement_3d_from_id`, `parse_cartesian_point`, `parse_cartesian_point_from_id`, `parse_direction`, `parse_direction_from_id` (R2a) | break #11 (R2a). Only external caller: `export/src/step_map_rigid.rs:124`, migrated in the same PR, plus two geometry tests |
| processing, export, wasm, server | internal only | nothing |

Each PR measures its own account with `cargo-semver-checks` against crates.io 20.4.0, as the ledger records for break #11.

### 2. Every current copy

Lines are at `38577fa7f8`. Tags: **C** = canonical behaviour today; **A** = agrees with the target rule; **D** = drifts (the § 3 item is named). → gives the replacement.

#### 2.1 rust/core

| file:line | copy | state | → | closes |
|---|---|---|---|---|
| `decoder.rs:610 get_cartesian_point_fast` / `:716 parse_cartesian_point_inline` / `:750 parse_point_coordinates` | strict byte grammar; **type-agnostic**; 2D → z=0; 1 or 4+ values → None | C (grammar) | stays the speculative probe; `point3`/`direction3` wrap it plus a keyword check (F4 later swaps in `StepRecord`) | XCUT-2 (core part) |
| `schema_gen.rs:225 parse_coordinate_list_3d`, `:247 _2d`, `:301 _3d_f64` | missing component → 0, f32/f64, no finiteness check; still reachable through #7752's `tessellated::admit_point_list` | D-§3.13 | refuse a malformed row (`Option`) | CORE-37 |
| `model_bounds.rs:178 extract_point_coordinates` | `str::parse`, `((`-literal | — | **F4** routes it to `StepRecord::point_at(0)` (already in the F4 note). The decoder-level `point3` does not apply to a byte scanner | CORE-13 readers → `fixed-by` the F4 model_bounds PR |
| `decoder/caches.rs:107-156` placement memo | `FxHashMap<u32, [f64; 16]>`, column-major, unscaled; grid-axis ids as extra keys | C | unchanged API; its doc changes from "the router owes the discipline" to "`placement::resolve_chain` owes it" | — |
| `limits.rs:41-74 MAX_PLACEMENT_DEPTH` | doc names a `profile_extractor` walk that no longer exists (`profile_extractor.rs:182` now calls the router) | stale | kept only for export's ParentContext walks (§4); doc rewritten | XCUT-27 (doc) |

#### 2.2 rust/geometry: canonical and placement readers (X1, X2, R1, X3a, R2a)

| file:line | copy | state | → | closes |
|---|---|---|---|---|
| `transform.rs:26 parse_axis2_placement_3d` | `$` Location → Err; Axis/RefDirection defaults +Z/+X; type-checked directions; `build_axis2_matrix` | C | `Axis2Placement::read_3d(..)?.matrix()` | GEOM-2, PROC-1 |
| `transform.rs:233 parse_axis2_placement_3d_from_id` | **`$` Location → origin** | D-§3.4 | same | GEOM-2 |
| `transform.rs:134/159/186` point readers (fast, then full; `:176-178`, `:214-216` copied triplets) | component → 0 | D-§3.1 | `point3` / `point3_at` | GEOM-28, XCUT-2 |
| `transform.rs:225/286` direction readers (`:303-305` triplet) | component → 0 | D-§3.1 | `direction3` | GEOM-28 |
| `transform/placement_2d.rs:14 parse_axis2_placement_2d` | own 2D assembly; 3D-normalises the RefDirection | D-§3.6 | `Axis2Placement::read_2d(..)?.matrix()` | GEOM-2, PROCESSING-SYM-2 (geometry home) |
| `router/transforms/parsers.rs:16/61/100` | jscpd clone of helpers; no fast path (full decode of every Location, ROUTER-3 ii) | C (behaviour) | bodies deleted; `GeometryRouter::parse_axis2_placement_3d`/`parse_direction` become one-line `pub(crate)` delegates **until C2**, because `router/voids/probe.rs:54,359,764` calls them and C2 owns `voids/*` | ROUTER-3 |
| `router/transforms/operator.rs:234 parse_direction_ratios` | copy of `parse_direction` | A | `direction3` | PROC-1, ROUTER-3 |
| `router/transforms/walk.rs:47/65` the chain walk | depth cap 100, no visited set; truncated → identity (`Ok`) | C, D-§3.7/§3.8/§3.9 | `placement::resolve_chain` (router keeps `get_placement_transform*` as `pub(super)` delegates mapping truncation to Err) | XCUT-27, GEOM-2 |
| `walk.rs:144-152`, `linear.rs:36-44`, `grid.rs:46-53` parent ladders | three spellings of "PlacementRelTo → resolve → depth+1" | A | `chain.rs::step` | ROUTER-16 |
| `walk.rs:155-171` RelativePlacement | non-3D (2D) → identity; `$` → identity | D-§3.5/§3.8 | `Axis2Placement::read` | — |
| `linear.rs:27/59` | local-frame failure swallowed → identity | D-§3.10 | `placement::linear` refuses | — |
| `grid.rs:27-75` | local failure swallowed → identity | D-§3.10 | `placement::grid` refuses | — |
| `mapped.rs:106 mapping_origin_transform` | 2D/3D dispatch, `$` → None | A | `Axis2Placement::read(..)?.matrix()` | GEOM-2 |
| `textured.rs:178-191` MappingOrigin | only 3D, other types silently None | D-§3.5 | same as `mapped.rs` | GEOM-2 |
| `layers.rs:512/528 attribute_placement_is_identity` | `_from_id`; Err means "not identity" | A | `Axis2Placement::read_id` | — |
| `processors/helpers.rs:31 parse_axis2_placement_3d` | **`$` Location → origin**; full decode | D-§3.4 | `Axis2Placement::read_3d` | GEOM-2, PROC-1, ROUTER-3 |
| `helpers.rs:83/121` point/direction copies (3rd and 4th) | component → 0 | D-§3.1 | `point3`/`direction3` | PROC-1 |
| `helpers.rs:178 get_axis2_placement_transform_by_id` | **fast path only; a miss snaps to the origin; every error swallowed** | D-§3.3/§3.4 | `Axis2Placement::read_id(..)?.matrix()` | GEOM-2 (`:181-185` silent origin) |
| `helpers.rs:219 get_direction_by_id` | **no type check**; x required; errors → None | D-§3.2 | `direction3` | PROC-1 |
| `helpers.rs:160 read_loop_points_by_id` | per-point fast path; #7752 adds the D14 seam | — | unchanged (a polyloop reader; F4's domain) | — |
| `profiles/placement.rs:13 apply_profile_position` | no type checks; a missing x ratio → **1.0**; 2D eps 1e-10 | D-§3.2/§3.6 | `Axis2Placement::read_2d(..)?.matrix()` projected | PROC-1 |
| `profiles/placement.rs:214 get_placement_2d` (2D branch) | hand-rolled; `$` Location → origin; x → 1.0 | D-§3.2/§3.4 | same | PROC-1, GEOM-2 |
| `profiles/mod.rs:782 axis2_placement_location_and_x_axis_3d` | **ignores Axis** (X not projected); `Option`-swallowing | D-§3.11 | `Axis2Placement::read_3d(..)?.matrix()` column 0 | PROC-1, GEOM-2 |
| `profiles/curves_3d.rs:69 read_conic_placement_3d` | delegates to `transform` | A | `Axis2Placement::read` | PROC-1 (done in part by #7745) |
| `processors/advanced_face/conics.rs:22 read_axis2_placement_frame` | delegates (#7745), but **Err → identity frame at the origin** | D-§3.3 | `Axis2Placement::read(..)?` → `Refused` | PROC-S7 (rest) |
| `processors/swept/revolved.rs:88-131` Axis1 | Axis default **+Y**; a missing y ratio → **1.0**; zero → +Y | D-§3.12 | `Axis1Placement::read` + WR refusal | PROC-S7 (Axis1) |
| `processors/advanced_face/revolution.rs:58-80` Axis1 | everything swallowed with `.ok()`; Location → origin; default +Z | D-§3.3 | `Axis1Placement::read(..)?` | PROC-S7 (Axis1), PROC-S9 |
| `revolution.rs:124-131` own basis | arbitrary reference axis | A (not a placement read; sampling basis) | stays | — |
| `processors/extrusion_params.rs:41-66` ExtrudedDirection | missing z → **1.0**; no finiteness check; tapered `.normalize()` unguarded | D-§3.12 | `direction3` + WR (z ≠ 0) refusal | PROC-1 (ExtrudedDirection reads) |
| `processors/sectioned_positions.rs:162 read_direction` | **no type check**, no finiteness check | D-§3.2 | `direction3` | PROC-AL-10 |
| `processors/sectioned.rs:362-391` linear-placement frame | own Z-then-X Gram–Schmidt from the curve | A (sampling frame, not Axis2) | stays | — |
| `processors/csg_primitive.rs:77-85`, `sphere.rs:61-69` | non-Axis2 Position silently ignored | D-§3.5 | `Axis2Placement::read_3d(..)?` | GEOM-2 |
| `processors/boolean/mod.rs:104-172`, `polygonal_prism.rs:93-120` | via `helpers` (`$` → origin) | D-§3.4 | `Axis2Placement::read_3d` | GEOM-2 |
| `processors/surface.rs:52-73`, `advanced_face/surfaces.rs:227-236` | via `helpers::get_axis2_placement_transform_by_id` | D-§3.3 | `Axis2Placement::read_id` | GEOM-2 |

#### 2.3 rust/geometry: inline leaf reads (X3b, R2b)

There are 45 point/direction reads in 22 files outside the placement readers, measured by grep plus reading each site (the review counted "48"/"60"; some have since moved or been fixed).

| site | state | → | closes |
|---|---|---|---|
| `advanced_face/polyline.rs:82-86` (IfcLine.Pnt → origin), `:96-104` (Orientation → +X), `:173-181`, `:240-255` | D-§3.1 (`:82` D-§3.3) | `point3_at`/`direction3_at`; zero direction → `Refused`, same as `curve_source::line_basis` | GEOM-1, PROC-S9 |
| `advanced_face/curves.rs:16 extract_vertex_coords` | **lenient**, while `structural_edge.rs:270 resolve_vertex_point` is strict for the same vertex | D-§3.1 | one `vertex_point` (= `resolve_vertex_point` on `point3`) | PROC-S9 |
| `curves.rs:157-169`, `bspline_parse.rs:111-119` control points | D-§3.1 | `point3` | GEOM-1, PROC-S9 |
| `curve_source.rs:24 point_values` (≥2, finite, allows 4+), `:40`/`:78` (no type check), `:119-152 mesh_line_basis` (lenient), `:188 circle_basis` (own 2D frame) | D-§3.1/§3.2/§3.6 | `point3`/`direction3`; `circle_basis` → `Axis2Placement::read` | GEOM-1 |
| `curve_segment.rs:101 read_placement` (Axis ignored, heading from the raw RefDirection) | A (alignment segments are planar; the strict validator rejects tilt) | reads through `Axis2Placement::read`; the heading stays | PROC-AL-10 |
| `alignment.rs:353-365`, `:649-656` (strict and tolerant modes) | A in strict mode, D-§3.1 in tolerant mode | `point3` (tolerant mode keeps its `.ok()` at the call site, which is visible policy) | PROC-AL-10 |
| `alignment_sampling_placement.rs:11 validate_placement`, `:78 validate_vector` | visited set + `len() > MAX`; exactly-3 and parallel checks | A (the strictest) | `validate_chain(ChainPolicy { strict_spatial: true, grid: false, linear: false, planar_relative: false })` | GEOM-19, PROC-AL-10 |
| `alignment_sampling_curve.rs:133 validate_primitive` | A | `point3`/`direction3` + its dimension check | PROC-AL-10 |
| `gradient.rs:138-155` | **reads attribute 1 as RefDirection whatever the placement type** (on a 3D placement attribute 1 is Axis): verify-first | D-§3.11 | `Axis2Placement::read` | PROC-AL-10 |
| `analytic/extrusion.rs:101-125` | A (2..=3, finite) | `direction3` | GEOM-1 |
| `router/annotation.rs:92-137 read_ring` | A | `point3` | GEOM-1 |
| `structural_edge.rs:270` | A | `point3` | PROC-S9 |
| `router/voids/probe.rs:150-196` inline 2D placement (x → 1.0) and polyline points | D | **C2** (owns `voids/*`, waves 3–4). Recorded as a C2 obligation, not a third copy | — |
| `router/rtc_offset.rs:233,265,333,345`, `rtc_offset/raw_coordinate.rs:35` | type-agnostic fast probes (the RTC vote) | — | stay on `get_cartesian_point_fast` (speculative, must not count) | — |
| `brep/faceted.rs:55-95`, `surface.rs:238,254`, `tessellated/mod.rs` | polyloop/list readers | — | F4 / B6 domain, not leaf readers | — |
| `texture/mod.rs:260` (UV) | not a point | — | out of scope | — |

#### 2.4 rust/processing (P1–P4)

| file:line | copy | state | → | closes |
|---|---|---|---|---|
| `symbolic/transform.rs:138 resolve_object_placement`, `:157 resolve_placement_for_symbolic` | recursive; **`depth > 50`** (51 links); no visited set; Local only (Grid/Linear → `unresolved`); per-level unit scaling; no memo (re-resolved per rep, `mod.rs:281`) | D-§3.7/§3.9/§3.14 | `placement::resolve_object_placement` + `Transform2D::from_matrix_xy(&m, unit_scale)` | PROCESSING-SYM-2, PROCESSING-SYM-16 |
| `symbolic/transform.rs:198 parse_axis2_placement_2d` | **Axis ignored**; RefDirection eps 1e-4; components → 0; no finiteness check | D-§3.1/§3.11 | `Axis2Placement::read(..)?.matrix()` → `from_matrix_xy` | PROCESSING-SYM-2, PROCESSING-SYM-6 |
| `symbolic/operator.rs:33` (CTO) point/direction reads (`:64-66`, `:92-93`, `:119-120`) | components → 0; missing origin → (0,0,0) | D-§3.1 | `point3_at`/`direction3_at` (the CTO assembly stays; it is not an Axis2Placement) | PROCESSING-SYM-6 |
| `symbolic/items.rs:151-198`, `fill.rs:93-165`, `trimmed_curve.rs:222`, `grid.rs:157`, `conic.rs:22`, `text.rs:40` | components → 0 (items/fill); grid drops the axis; conic/trimmed check finiteness | D-§3.1 | `point3`/`point3_at`; a refusal maps to the existing drop path | PROCESSING-SYM-6 |
| `symbolic/mod.rs:36-42` "intentionally diverges" | stale (SYM-2) | — | rewritten: "the 3D chain, projected" | PROCESSING-SYM-2 |
| `analytic_export/placement.rs:11 validate_placement_chain` (+ `:114/126/137`) | HashSet, checked **before** insert (101); Grid schema-aware; Linear type-only; 2D refused | D-§3.9 | `validate_chain(ChainPolicy { grid: true, linear: true, planar_relative: false, strict_spatial: false })` | GEOM-19, XCUT-27 |
| `appearance/source.rs:99 validate_world_placement` (4 callers) | BTreeSet, checked **after** insert (100); Local only; 2D accepted unchecked | D-§3.9/§3.1 | `validate_chain(ChainPolicy { grid: false, linear: false, planar_relative: true, strict_spatial: false })` | GEOM-19, XCUT-27 |
| `stream_meta.rs:180-196`, `processor/mod.rs:1083/1090`, `appearance/{authored,mapping,evaluated_source}.rs`, `analytic_export/walk/seed.rs:49`, `mesh_frame.rs` | call `resolve_scaled_placement[_strict]` | A | unchanged (the router delegates to `resolve_chain`) | — |

#### 2.5 rust/export (E1)

| file:line | copy | state | → | closes |
|---|---|---|---|---|
| `step_map_transform_preflight.rs:277 placement` | Vec, `len >= MAX` (100); Local → `axis()`; Linear only if Axis/RefDirection are unset; Grid refused | D-§3.9 | `validate_chain(ChainPolicy { grid: false, linear: true, planar_relative: false, strict_spatial: true })` + its own Linear-attribute rule (export policy, kept) | GEOM-19, XCUT-27 |
| `step_map_transform_preflight.rs:314 axis` | exactly 3, finite, non-zero, cross ≤ 1e-12 | A (= `strict_spatial`) | `Axis2Placement::read_3d` + `strict_spatial` | GEOM-19 |
| `step_map_rigid.rs:193 placement_root` (iterative; memo of (root, depth); `>= MAX`) | D-§3.9 | `placement::chain(..)` (root = last link); its own memo stays | XCUT-27 |
| `step_map_rigid.rs:124` | the only external caller of `ifc_lite_geometry::parse_axis2_placement_3d` | A | `Axis2Placement::read_3d(..)?.matrix()` | — |
| `step_map_transform_preflight.rs:234`, `step_map_rigid_contexts.rs:100`, `landxml_terrain_georef.rs:83` | **ParentContext** walks that borrow `MAX_PLACEMENT_DEPTH` | — | not placement chains: out of F3b. L-export gives them `MAX_CONTEXT_DEPTH` | — |
| `step_log/extract.rs:188` literal `100` | STEP list nesting, **not** placements (XCUT-27 mis-cites it) | — | out of scope (F4/L-export) | XCUT-27 (citation corrected) |
| `model.rs:331`, `landxml_terrain_tin.rs:44`, `step_map_transform.rs:127` | router calls | A | unchanged | — |

#### 2.6 wasm, server, TS twins, the rest

| file:line | state | → | closes |
|---|---|---|---|
| `wasm-bindings/src/api/grid_lines.rs:75`, `alignment_lines.rs:115` | `resolve_scaled_placement(..).unwrap_or(IDENTITY)`: an error silently draws at the origin | D-§3.15 → skip the overlay item | — |
| `grid_lines.rs:142-163 sample_axis_endpoints` | x,y required, z → 0 even when z is a non-number | A except garbage z | `point3` | GEOM-1 |
| `apps/server/src/services/data_model/spatial_elevation.rs:78` | `get_cartesian_point_fast` on Location: **no type check at any hop** | D-§3.2 | `point3` (one level only, by design) | — |
| `packages/parser/src/spatial-hierarchy-attributes.ts:135 extractPlacementElevation` | TS twin of the above: **requires ≥3**, so a 2D Location gives `undefined` where Rust gives z = 0 | D-§3.6 | the 2D promotion (D26) in the **same PR** as the server change, with a parity vector (D5) | — |
| `packages/data/src/axis2-placement.ts:41 firstProjAxis` | parity-pinned with `rust/geometry/tests/absent_ref_direction_fill.rs` | A | unchanged; `build_axis2_matrix` is bit-identical | — |
| `packages/export/src/lod0-generator.ts:210 getPlacementMatrix` | **no cap, no cycle guard**: a self-referencing `PlacementRelTo` overflows the stack | bug | new TS follow-up issue (S1 class); not F3b (D20 precedent) | — |
| `apps/viewer/src/lib/compare/worldPlacement.ts:334` (cap 64), `geo/storey-elevation.ts:96`, `packages/create/src/in-store/*` (5 walkers), `packages/cli/src/commands/storey-selection.ts:32`, `packages/export/src/{anonymize-placement,grid-placement-dependents}.ts` | TS-only walkers, not parity-locked | — | one TS follow-up, "one TS placement walker" (D20 precedent) | — |
| clash, ffi, landxml, python, cloud-import | no readers (confirmed) | — | no PR | — |

### 3. Drift reconciliation

"Canonical" is the target. "Proof" is what the PR that moves the drift must show. Unless stated, the corpus effect is expected to be **none**: the 111 fixtures with placements have no malformed leaf, no cycle and a deepest chain of 7 (`limits.rs:66-69`). Each X PR still runs the full fingerprint set and lists the files that moved, which should be none.

| # | Drift | Where (state D above) | Canonical | Class / proof |
|---|---|---|---|---|
| 3.1 | **Unreadable component** (missing, non-number, typed wrapper; 0/1/4+ values) | every `unwrap_or(0.0)` site: transform.rs, helpers, parsers, operator, curve_source (lenient half), advanced_face/*, symbolic/* | refuse and count (D3) | X1 (canonical readers) and X3b / P3 (forks), each with a test: `IFCCARTESIANPOINT((1.))`, `((1.,'x'))`, `((1.,2.,3.,4.))` refuse at base+1 and read `(1,0,0)` / `(1,0,0)` / `(1,2,3)` at base. Counter delta asserted |
| 3.2 | **Type check** | absent in the fast path, `get_direction_by_id`, `sectioned_positions`, `profiles/placement.rs`, `curve_source.rs:40/78`, server elevation | required (`IfcCartesianPoint` / `IfcDirection`) | X1 (fast path inside `point3`), X3a/X3b, S1. Test: an `IfcDirection` id in a Location slot refuses |
| 3.3 | **Error swallowing to identity/origin** | `helpers.rs:178` (fast-only + `.unwrap_or`), `conics.rs:40`, `revolution.rs:58-80`, `polyline.rs:82` | propagate (`?`); processors map to their existing refusal (`Refused`, `Err`) | X3a/X3b. Tests per site: an unreadable Location refuses the face/surface instead of placing it at the origin |
| 3.4 | **`$` Location** | Err: `transform.rs:26`, router, `placement_2d`; origin: `_from_id:240`, `helpers.rs:37-45`, `profiles/placement.rs:214`; None: `profiles/mod.rs:791` | **refuse** (mandatory; D3; also what the mesh walk does today) | X3a. Test per spelling |
| 3.5 | **Wrong placement type in a placement slot** | `walk.rs:162` (2D → identity), `textured.rs:183` (2D → None), `csg_primitive`/`sphere` (ignored) | `Axis2Placement::read`: 2D honoured where IFC allows the select (LocalPlacement.RelativePlacement, MappingOrigin); other types refuse | X2 (walk), X3a (textured, primitives). Test: a 2D RelativePlacement translates the product |
| 3.6 | **2D in 3D (promotion)** | points/directions: z = 0 everywhere except `profiles/placement.rs:48` / `get_placement_2d` (x → 1.0), the TS parser twin (≥3 required); 2D placements: `placement_2d.rs` assembles directly, `symbolic` projects, `curve_source.rs:188` builds its own frame | 2 → z = 0 (D26). A 2D placement = `build_axis2_matrix(loc, +Z, ref)` | X1 for `placement_2d` → `build_axis2_matrix`. **Bits:** `build_axis2_matrix` normalises X twice and Y once, where `placement_2d` normalises once and writes Y exactly. Axis-aligned RefDirections are exact, but rotated profile positions may move by 1 ulp. X1 lists the fingerprint delta and re-accepts snapshots if any move. TS: S1 |
| 3.7 | **Chain bound** | router: depth 100, no set; symbolic: 50; validators: 100/101 (set before/after insert); export: 100 (`>=`) | iterative + visited set, **no cap** (D27) | X2 (router) with `placement_depth_tests.rs` rewritten: a 150-link chain resolves fully, cold and warm alike (base: truncated, order-dependent). P1 (symbolic 50 → shared constant) ships **first** as a tiny standalone X for SYM-16; P2 then removes the cap with the rest. P4/E1: the validators' off-by-ones vanish |
| 3.8 | **Cycle** | router: composes 101 locals, `truncated` (only `_strict` refuses); symbolic: about 51 compositions, `tz = NaN`; validators: Err | `PlacementError::Cyclic`, counted; every consumer refuses (symbolic: `unresolved`, §3.14) | X2. Test: a 2-cycle refuses at head and renders (displaced) at base; `refused_input_elements` = 1 |
| 3.9 | **Accepted kinds** | router: Local/Linear/Grid; symbolic: Local; analytic: Local+Grid+Linear(type-only); appearance: Local(+2D); export: Local+Linear(strict); alignment: Local+3D | `resolve_chain` accepts all three. Validators state their subset in `ChainPolicy` (a consumer's limit, `Policy` error, not counted) | P2 (symbolic gains Grid/Linear: **user-visible**, symbols under grid-placed columns and linearly placed signals now draw in place instead of at the origin), P4, E1 |
| 3.10 | **Linear/Grid local-frame failure** | `linear.rs:59`, `grid.rs:61`: swallowed → identity (the element sits at the parent origin) | refuse and count (D3); `resolve_linear_placement_local_strict` already does | X2. Test per kind |
| 3.11 | **Axis ignored** | `profiles/mod.rs:782` (X not projected against Axis), symbolic `parse_axis2_placement_2d` (Axis never read), `gradient.rs:138` (attribute 1 read as RefDirection on a 3D placement, verify-first) | Axis honoured via `build_axis2_matrix` | X3a (profiles), X3b (gradient; first commit reproduces), P2 (symbolic: a tilted parent now projects foreshortened. **User-visible** for tilted plan placements, which are rare; the symbolic T3 hash re-pins only if the corpus moves) |
| 3.12 | **Missing/2-ratio defaults that invent geometry** | `extrusion_params.rs:51` z → 1; `revolved.rs:106-131` Axis +Y, y → 1, zero → +Y | refuse where an IFC WR rules out the promoted/default value: `ExtrudedDirection` z ≠ 0 (`ValidExtrusionDirection`), revolved axis in XY (`AxisDirectionInXY`, `AxisStartInXY`). The surface-of-revolution axis keeps the IFC default +Z | X3a. Tests: `IFCDIRECTION((1.,0.))` as ExtrudedDirection refuses (base: extrudes along (1,0,1)); a revolved solid with `$` Axis refuses (base: revolves about +Y) |
| 3.13 | **CORE-37** coordinate-list helpers default to 0 | `schema_gen.rs:225/247/301` | refuse a row whose length is not the declared dim, or which contains a non-number. `parse_index_list` was already fixed by B6e | C2 (core). Test through `tessellated` (the only caller). Corpus: none |
| 3.14 | **Unit scaling order (symbolic)** | symbolic scales each level's translation; the mesh path scales the composed matrix (`scale_transform`) | composed, then scaled (the memo is unscaled) | P2. `s·(R·t + t_p)` vs `R·(s·t) + s·t_p` differ by about 1 ulp in millimetre files: the symbolic T3 hash (`extract_symbolic_data`) and the symbolic goldens re-pin in P2, with that reason. The 2×2 block is bit-identical for Z-up chains: each 4×4 term adds an exact `+0` |
| 3.15 | **Error → identity in overlays** | wasm `grid_lines.rs:75`, `alignment_lines.rs:115` | skip the item (the overlay is not drawn) | W1, `pnpm changeset` (patch). The signature is unchanged, so no `.d.ts` |
| 3.16 | **f32 vs f64** | readers f64 everywhere except `schema_gen` f32 lists and symbolic f32 primitives | f64 through resolution; f32 only at the existing boundary casts (B5 rule, `rust/AGENTS.md`) | no change |
| 3.17 | **Zero-length / parallel axes** | `build_axis2_matrix` repairs (1e-9 / 1e-6); symbolic eps 1e-4; `profiles/placement.rs` 1e-10; `curve_source` 1e-12 → Err | `build_axis2_matrix`'s repair, unchanged (D25). The `strict_spatial` policy refuses for validators | X1/X3a/P2 move the minority epsilons onto the canonical one. Tests at 5e-5 (symbolic: base `(1,0)`, head canonical) |
| 3.18 | **`#2256` vs D15** | symbolic `unresolved()` (keep at the local origin, `tz = NaN`) for dangling/cycle/unsupported; #7752's `refused()` (drop) for admission | `resolve_object_placement` Ok(None) → `identity`; `is_admission_refusal()` → `refused()` (D15, now also for malformed leaves and the `$` mandatory attribute); every other error → `unresolved()` (#2256, unchanged until C5) | P2. This also closes #7752's gap: an admission refusal *inside* the chain (`transform.rs:149-151,168-186`) now drops the symbol instead of keeping it at the origin. Test |

**Byte-identity of the R PRs.**
- **R1:** a move. The iterative fold composes `((T_root·L_1)·L_2)…`, the same left-associated order the recursion produces, and the memo holds the same column-major arrays.
- **Fast path:** once every Location goes through `point3` (the router previously decoded every Location in full), the values parse through `parse_step_numeric`. On main the full decode goes through `lexical_core`. Both round correctly, so finite literals give the same bits. The F4 differential fuzz (G7) covers this.
- **R2a/R2b:** replace sites already reconciled by X1–X3, so they are equal by construction.
- **Evidence for every R PR:** §1.2 (a)–(f), the same set F2a listed.

### 4. The bounding walk and the cache

**Choice: iterative, with a visited set, and no cap.**
- **Shape:** `PlacementRelTo` is a single reference, so each step has exactly one parent. The IFC2X3/IFC4 grid owner (`IfcGridAxis` → `IfcGrid.ObjectPlacement`) is also one parent, not a fan-out. That rules out a work budget: there is no DAG breadth to bound.
- **Why not a depth cap:** a cap only protects a stack, and an iterative walk has none. AGENTS.md says to prefer iterative and states that the visited set is then sufficient alone.
- **Why a set:** it is what turns a cycle into a refusal rather than a composed garbage transform.
- **Scope:** path-scoped is the same as global within one resolution, because the walk does not branch. The cross-resolution memo stores complete results only.
- **`check-refwalk-guards.mjs`:** sees a cursor-chasing loop that reaches `decode_by_id` with a set in scope, and passes. Deleting the recursive `get_placement_transform_with_depth` and `resolve_placement_for_symbolic` lowers the candidate count, so the X2/P2 lane adjusts `CANDIDATE_FLOOR` (`:206`) as the gate instructs. B6c did the same.
- **Why the cap goes rather than stays:** with the memo consulted first, a capped walk's outcome depends on which product warmed which ancestor (`walk.rs:20-28`). Today that is a truncated-vs-whole *matrix*. Under D3 it would become refused-vs-drawn, varying across thread counts and the native/wasm batch split, which `mesh_determinism` and G3 exist to forbid. Without a cap the result is a pure function of `(content, id)`.
- **`MAX_PLACEMENT_DEPTH` after F3b:** it no longer bounds placement chains, and its doc says so. Its remaining users are export's three ParentContext walks; L-export renames that bound `MAX_CONTEXT_DEPTH` and deletes the placement constant together with the `limits.rs:187` pin test (§9 ledger re-map).
- **This deviates from the charter's literal wording**, "depth from `core::limits`". AGENTS.md wins over PLAN (PLAN header), so it is recorded as D27.
- **Cost:**
  - **Memo hit:** O(1). The check happens before anything is allocated.
  - **Miss:**
    - The walk climbs into a `SmallVec<[(u32, Matrix4<f64>); 8]>`, which needs no heap at the corpus depth of ≤ 7.
    - Cycle membership is a linear scan of the path while it holds 16 entries or fewer, and switches to an `FxHashSet` beyond that, so an adversarial 10⁵-link chain costs O(n), not O(n²).
    - The fold then runs top-down and memoises every node, as the recursion does today.
  - **Errors:** never memoised. A cycle shared by k products costs k climbs, each O(cycle length), and refuses k elements, each counted, which is correct under D3.

**Caching.**
- **Where:** the one memo is core's `placement_transform_cache`, keyed by placement id (plus grid-axis ids for the owning-grid frame, `grid_frame.rs:69,91`). Values are column-major and **unscaled**.
- **Sharing:**
  - **Native:** per worker, across products (`jobs.rs:164-178` hoists it, `jobs.rs:78` writes it back). Nothing changes.
  - **New:** symbolic, the validators and export now read and fill the same memo through `resolve_chain` on their own decoders. Today symbolic re-resolves the chain for every representation (`symbolic/mod.rs:281`).
  - **Validators:** `validate_chain` does not memoise, because a policy verdict is not a pure function of the id.
- **Invalidation:**
  - **Not needed.** A decoder's content is immutable, and a memo entry is a pure function of `(content, id)`, which is now strictly true.
  - **What clears it:** `clear_cache` clears it; `clear_entity_cache` keeps it (`caches.rs:62-73`, unchanged).
  - **Scaling:** stays out of the memo, so readers using different unit contexts (router `unit_scale`, symbolic `unit_scale`) share entries safely.

### 5. Migration order

Branches are `sweep/f3b-<tag>`. Opus writes C1, X1, X2, R1, P2 and E1; Sonnet takes the rest. "Size" is changed lines, including tests.

| # | PR | Class | Crate | Depends on | Size | Conflicts / ownership |
|---|---|---|---|---|---|---|
| 1 | **C1** leaf readers, `resolve_optional`, `MalformedRecord`, counter name | R (additive + break #11) | core | **#7752 merged** (decoder.rs, error.rs, counter) | ~380 | F4-1 also edits `decoder.rs`; whichever lands second rebases (disjoint hunks: C1 adds `decoder/leaf_read.rs`) |
| 2 | **C2** CORE-37 coordinate-list refusal | X | core | C1 | ~140 | #7752's `tessellated/mod.rs` (merged by then) |
| 3 | **X1** canonical leaf policy (§3.1, 3.2, 3.6 placement_2d, 3.17) in `transform.rs`, `transform/placement_2d.rs`, `router/transforms/parsers.rs` | X | geometry | C1 | ~300 | after G1 (G1 touches `router/transforms/*`) |
| 4 | **X2** canonical chain policy (§3.5 walk, 3.7, 3.8, 3.10) in `walk.rs`, `linear.rs`, `grid.rs`, `grid_frame.rs`; `placement_depth_tests.rs` rewritten | X | geometry | X1, **G1 and G2 merged** | ~550 | F2a G2 also touches `router/transforms/mesh_world.rs` (not this set). The refwalk floor moves |
| 5 | **R1** the `placement` module: move `build_axis2_matrix`, Axis2/Axis1, `chain.rs`, linear/grid; router delegates; canonical readers onto `point3`/`direction3` | R | geometry | X1, X2 | ~1,100 (≈80% moves) | `router/transforms/*` exclusive to F3b while R1 is open |
| 6 | **X3a** placement-reader forks in place (§3.3 helpers, 3.4, 3.5 textured/primitives, 3.11 profiles, 3.12) | X | geometry | R1; **#7747, #7762, #7769 merged** (revolved, extrusion, boolean, surface) | ~550 | hot files: `processors/helpers.rs`, `profiles/placement.rs`, `profiles/mod.rs`, `extrusion_params.rs`, `swept/revolved.rs`, `boolean/*`, `router/textured.rs` |
| 7 | **X3b** leaf-read forks in place (§3.1, 3.2, 3.3 in advanced_face/*, curve_source, curve_segment, gradient verify-first, alignment tolerant) | X | geometry | R1 | ~450 | `advanced_face/*` (B6c is merged; no open owner) |
| 8 | **R2a** delete placement forks: `helpers.rs:31-230` placement half, `parsers.rs` bodies, `operator.rs:234`, `transform.rs` + `placement_2d.rs` (the pub readers, break #11), `profile` 2D readers; export `step_map_rigid.rs:124` | R (+ break #11) | geometry (+1 export line) | X3a | ~900 | — |
| 9 | **R2b** delete inline leaf reads (§2.3 rows marked →) and `alignment_sampling_placement.rs` onto `validate_chain` | R | geometry | X3b, R1 | ~700 | — |
| 10 | **P1** SYM-16: `depth > 50` → `ifc_lite_core::MAX_PLACEMENT_DEPTH` | X | processing | #7752 merged (same file) | ~40 | can ship at once; independent of the home |
| 11 | **P2** symbolic chain and Axis2 onto `placement` (adopt-as-X, D28): `Transform2D::from_matrix_xy`, the §3.18 mapping, the `mod.rs:36-42` doc | X | processing | R1, P1 | ~400 | symbolic T3 hash and goldens re-pin (§3.14) |
| 12 | **P3** symbolic leaves (items, fill, trimmed_curve, grid, operator) → `point3`/`direction3` | X | processing | P2 | ~250 | — |
| 13 | **P4** `analytic_export/placement.rs` + `appearance/source.rs` → `validate_chain` (adopt-as-X) | X | processing | R1 | ~300 | — |
| 14 | **E1** export preflight, `placement_root` → `validate_chain` / `chain` (adopt-as-X) | X | export | R1 | ~350 | the export golden corpus is unchanged (expected) |
| 15 | **W1** wasm overlays: Err → skip; grid endpoints → `point3` | X | wasm | C1, R1 | ~90 + changeset | none |
| 16 | **S1** server elevation → `point3`; TS `extractPlacementElevation` 2D promotion + parity vector (D5) | X | apps/server + packages/parser | C1 | ~150 + TS changeset | S4/C8 own `routes/*`; this touches `services/data_model/spatial_elevation.rs` only |

- **Parallelism:**
  - P1 can go now (after #7752).
  - C1 → X1 → X2 → R1 is the serial spine.
  - After R1: X3a ∥ X3b ∥ P2 ∥ P4 ∥ E1 ∥ W1 ∥ S1.
  - Then R2a after X3a and R2b after X3b, and P3 after P2.
- **G3:** the one F3b grep lands with the last migration. It bans `(coords|ratios)\.(first\(\)|get\(\d\))\.and_then\(\|v\| v\.as_float\(\)\)\.unwrap_or\(` (the copied spelling) in non-test `rust/*/src` and `apps/server/src`, outside `core/src/decoder/leaf_read.rs`. `router/voids/probe.rs` is excepted until C2.

### 6. Stop line

- **Required:** C1, X1, X2, R1, X3a, R2a, P1, P2, P4, E1.
  - These close every High finding: XCUT-1/2, ROUTER-3, PROC-1, GEOM-1 (the cross-crate half), GEOM-2, SYM-2, SYM-6 (chain/Axis2 half). They also close the medium chain findings XCUT-27, GEOM-19, SYM-16, ROUTER-16.
  - After these, no crate outside geometry composes a placement chain or reads an Axis2Placement, and geometry has one reader.
- **Optional:**
  - **X3b/R2b:** inline leaves inside geometry processors. They are in the crate that owns the home and cannot spread. **C1a absorbs them** if F3b stops (its curve sampler rewrites `curve_source`, `polyline`, `curves`, `bspline_parse`), and the ledger rows become `fixed-by:` C1a.
  - **P3:** symbolic leaves. C5 absorbs them.
  - **C2:** CORE-37 is Low.
  - **W1, S1:** small and user-visible; strongly recommended.
- **If migration stalls at crate N:**
  - Every home item is additive and stays.
  - R1 makes the router walk and `transform.rs` thin delegates *in the same PR* that adds the home. So from R1 on there are never two chain walks or two Axis2 readers inside geometry, and a stalled X3/R2 leaves only the named forks of §2.2, already reconciled by X3a.
  - A crate whose PR has not landed keeps its old code untouched.
  - **Safe to delete at any point, independent of order:** `helpers.rs` placement functions (crate-local callers), `operator.rs:234`, `profiles/placement.rs` 2D readers, symbolic `resolve_placement_for_symbolic` (after P2), `appearance/source.rs:99` (after P4).
  - **Not safe before C2:** the router `parse_*` delegates (`voids/probe.rs` calls them).

### 7. Perf

Placement resolution runs once per product (plus mapped/grid hops), not once per vertex, but at 10⁵ products it shows in the `geometry` phase. Expected movement and gates:

- **Router Location reads move from a full decode to the fast path.** `parsers.rs:61` decodes every `IfcCartesianPoint` into `AttributeValue`s, the per-point allocation `router/content_hash.rs:294` documents. Directions also gain a fast path. This should *lower* `lookup` and `geometry` Ir.
- **Added work:** one keyword compare per leaf (≤ 17 bytes, case-folded) and one `SmallVec` per memo miss. The memo-hit path is unchanged: one `FxHashMap` lookup, then return.
- **`build_axis2_matrix` is unchanged.** The `Axis2Placement` struct is a by-value intermediate and inlines away.
- **Symbolic gets faster:** it gains the memo, where today it walks the chain per representation.
- **Gates per PR touching `router/transforms`, `placement/*`, `decoder/leaf_read.rs` or symbolic:**
  - (1) `scripts/perf/instructions.sh` base vs branch on `AC20-FZK-Haus` (CI `native-instructions`) and `ISSUE_129` (`--set large`, local), plus `duplex` (product-heavy). The PR posts the per-phase table, and every phase must be ≤ base × 1.0005. That is the F4 contract; there is no trading between phases.
  - (2) `scripts/perf/probe.sh` interleaved A/B with a neutral verdict.
  - (3) The CI perf ratchet is green.
  - X2/R1 also run a synthetic 10⁴-product, 7-deep chain in a geometry bench test (`placement/chain_tests.rs`, `#[ignore]`d, run by the lane) to show the memo-hit path is flat.

### 8. Docs touched

- **`rust/AGENTS.md`:** one bullet. "Points and directions are read with `EntityDecoder::{point3, direction3}[_at]` (one rule: 2 or 3 numbers, 2D promotes z = 0, anything else is refused and counted). Placements are read with `ifc_lite_geometry::placement::{Axis2Placement, resolve_chain, resolve_object_placement, validate_chain}`. Never hand-roll `.as_float().unwrap_or(0.0)` or a `PlacementRelTo` walk; the G3 grep enforces the first."
- **`AGENTS.md` "Bounding walks":** one sentence naming `placement::resolve_chain` as the iterative-plus-visited-set example. "Reuse the shared bound" stays.
- **`rust/core/src/limits.rs:41-74`:** the `MAX_PLACEMENT_DEPTH` doc. Remove the stale `profile_extractor` walk, and say placement chains are walked iteratively without a cap; the constant remains for the export context walks until L-export.
- **`rust/core/src/decoder/caches.rs:132-154`:** memo discipline now owed by `placement::resolve_chain`.
- **`rust/geometry/src/lib.rs:70-75`:** public module count. `transform.rs` and its "every parser keeps its own extraction" doc (`:66-77`) are deleted; `build_axis2_matrix`'s doc is rewritten as the only orthonormalisation.
- **`rust/processing/src/symbolic/mod.rs:36-42`:** "the shared 3D chain, projected to XY", replacing "intentionally diverges".
- **`docs/architecture/geometry-pipeline.md:363-400` "Placement Stack":** replace the illustrative `compute_transform` with `placement::resolve_chain`. Add the refusal policy (malformed, cyclic and unsupported placements refuse the element and are counted in `refused_input_elements`) and the unscaled-memo rule.
- **`docs/architecture/coordinate-handling.md`:** no change. It describes RTC sampling, which goes through `resolve_scaled_placement` with its signature unchanged.
- `docs/guide/exporting.md:46-52,643`: still accurate (export's Linear/`PlacementRelTo` policy is kept as a `ChainPolicy` plus its own rule).

### 9. What C1a and C2 consume

- **C1a (one curve sampler):**
  - **Leaf reads:** `point3`/`direction3`/`_at` and `resolve_optional` for every trim, vertex, control and line point. C1a writes no coordinate reader.
  - **Conic, circle and ellipse frames:** `Axis2Placement::read(..)?.matrix()` (2D and 3D), replacing `curve_source::circle_basis`'s own 2D frame, `curves_3d::read_conic_placement_3d` and `conics::read_axis2_placement_frame`.
  - **Revolution axes:** `Axis1Placement`.
  - **Refusals:** a reader refusal is a counted `MalformedRecord`, so C1a's trimming refusals (PROC-S20) report through the same counter.
  - **If F3b stopped at the stop line:** C1a takes over X3b/R2b's sites (§6).
- **C2 (router restructure):**
  - **Already moved out by F3b:** the placement chain no longer lives in `router/transforms`.
  - **`RepresentationWalk`** calls `placement::resolve_object_placement` (scaled by the router) and `Axis2Placement::read` for MappingOrigin. The mapped walk is already on it after R1/X3a.
  - **Deletions in C2:**
    - the router `parse_axis2_placement_3d`/`parse_direction` delegates;
    - the `voids/probe.rs:150-196` inline 2D placement reader, moved to `Axis2Placement::read_2d`;
    - probe's `.ok()` placement calls, which become explicit refusals or the exact-kernel deferral.
  - **RTC vote:** C2 decides whether the `rtc_offset.rs` type-agnostic fast probes should use `point3` (they must not count).
- **C5 (symbolic)** inherits a symbolic module already on `resolve_chain`. C5 decides the broader #2256 revision, i.e. whether `unresolved()` should become `refused()` for dangling and cyclic placements.
- **C4** carries `refused_input_elements` (now including F3b's refusals) through `ProcessingSink`.

---

### Needs a decision

Coordinator decisions to record (proposed D25–D30):
- **D25:** readable-but-degenerate axes (zero-length, parallel) are repaired by `build_axis2_matrix` unchanged; unreadable values are refused (D3). Exception: an IFC WR that rules out the repaired or default value for the consumer refuses (`ExtrudedDirection` z ≠ 0; revolved-solid axis in XY).
- **D26:** 2-component points and directions promote to 3D with z = 0 everywhere, in Rust and in the TS server-elevation twin. 0, 1 or ≥4 components refuse.
- **D27:** `resolve_chain` is iterative, with a visited set and no depth cap. Cycles refuse and are counted. `MAX_PLACEMENT_DEPTH` stops bounding placement chains, and L-export retires it. This is a deliberate deviation from the charter's "depth from core::limits" (AGENTS.md wins); the reason is memo determinism (§4).
- **D28:** adopt-as-X. When reconciling a fork in place would re-implement logic the home has, or the site is a single call, the X PR adopts the home directly, contains nothing else, and pins each drift with a test. Used by P2, P4, E1, W1 and S1. Every other fork goes X in place, then R delete.
- **D29:** one counter. `refused_input_elements` counts F3b refusals, and core's accessor is `refused_records()`. Ask #7752's lane to rename it before merge; otherwise C1 renames it under break #11.
- **D30:**
  - **Refuse:** a `$` mandatory placement attribute (Location, `RelativePlacement`) or a non-placement in `PlacementRelTo`.
  - **Identity:** a `$` ObjectPlacement (#2256, genuinely missing).
  - **Symbolic mapping:** an admission or malformed refusal gives `refused()` (D15); any other error gives `unresolved()` (#2256, until C5).

Ledger re-maps:
- **CORE-13 (readers half)** → `fixed-by` the F4 PR that moves `model_bounds` onto `StepRecord::point_at`. The `1000.0` half stays in F3a.
- **XCUT-1** → `fixed-by` the F3b and F2a required PRs jointly (placement half here, math half in F2a).
- **XCUT-27's** `step_log/extract.rs:188` citation is STEP nesting, not a placement walk. Record it as a mis-citation.
- **`router/voids/probe.rs:150-196`** inline 2D placement and `rtc_offset` probes → C2.
- **New follow-ups:**
  - (L-geometry) `profiles/placement.rs:104 apply_cartesian_transformation_operator_2d` is a second 2D CTO next to `operator.rs`'s "SINGLE definition". It has no orthogonalisation and no Scale finiteness check.
  - (L-geometry, behaviour) `IfcAxis2PlacementLinear` Axis/RefDirection (attributes 1 and 2) are never read (`linear.rs:112-113`).
  - (L-export) `MAX_CONTEXT_DEPTH` for the three ParentContext walks.
  - (TS, S1 class) `packages/export/src/lod0-generator.ts:210` recurses on `PlacementRelTo` with no guard, so a self-reference overflows the stack.
  - (TS) one TS placement walker for the eight unlocked TS walkers (D20 precedent).

Maintainer: nothing blocking. FYI, these are user-visible effects, all expected to be zero on the corpus:
- **(1)** Malformed points or placements, cycles and failed linear/grid frames now refuse the element and count it, where today it is drawn at a fallback position. This is D3, already approved.
- **(2)** Plan symbols under `IfcGridPlacement`/`IfcLinearPlacement` products now draw in place instead of at the origin, and symbols under tilted parent placements are projected.
- **(3)** Placement chains longer than 100 links now resolve in full instead of truncating.

Docs touched: `rust/AGENTS.md`, `AGENTS.md` (bounding walks, one sentence), `rust/core/src/{limits.rs,decoder/caches.rs}` (docs), `rust/geometry/src/lib.rs` (comment), `rust/processing/src/symbolic/mod.rs` (module doc), `docs/architecture/geometry-pipeline.md` (Placement Stack).
