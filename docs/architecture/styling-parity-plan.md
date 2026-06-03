# IFC Styling & Default-Rendering Parity — Research & Plan

Status: **proposed** (research complete; implementation not started).
Owner: geometry / processing core.
Tracking: [#913](https://github.com/LTplus-AG/ifc-lite/issues/913).
Related: `docs/architecture/rendering-pipeline.md`, `docs/architecture/geometry-pipeline.md`,
`docs/architecture/clash-detection-plan.md` (the "one shared core" precedent).

This is the *what/why* of closing the styling gap between every rendering path in
the repo, **and** the structural changes that stop it reopening. It is research +
a phased plan + an anti-regression design, not a record of shipped work.

---

## 0. Problem statement

ifc-lite turns one IFC file into colored meshes in **four** independent Rust
consumers, plus a TypeScript 2D path:

- **Browser** — `rust/wasm-bindings` (streaming pre-pass → worker → GPU).
- **Backend crate** — `rust/processing` (the shared CPU pipeline).
- **REST/stream server** — `apps/server` (depends on `processing`, but keeps its own color code).
- **Desktop (Tauri)** — `apps/desktop` (depends only on `ifc-lite-geometry`).
- **2D drafting** — `packages/renderer` (TypeScript, intentionally its own palette).

They are **not rendering-equivalent today**. The same file renders authored colors
in the browser and fallback gray in the backend; default colors differ per type;
the desktop app diverges on ~14 types. The root cause is structural: **color logic
was copied into each consumer instead of shared**, and the copies drifted (§3).

`symbolic` extraction is *not* part of this gap — it already lives in the shared
`ifc_lite_processing::symbolic` module with a parity test, and is wrapped by the
browser. It is the model this plan follows for styling.

---

## 1. Where styling lives today

| Concern | Browser (`wasm-bindings`) | Backend (`processing`) | Shared? |
|---|---|---|---|
| `IfcStyledItem` chain → `IfcSurfaceStyle` → `IfcColourRgb` | `api/styling.rs:134–325` | `processor.rs:1504–1849` | ❌ duplicated |
| `IfcIndexedColourMap` / `IfcColourRgbList` | `api/styling.rs:23–78` (+ per-triangle split in `api/gpu_meshes.rs`) | **absent** | ❌ wasm-only |
| Material chain (orphan `IfcStyledItem`, material `SELECT` walk) | `api/styling.rs:552–821` | **absent** | ❌ wasm-only |
| Submesh color + transparent/opaque preference | `api/styling.rs:828–890` | `processor.rs:1428–1459` | ❌ diverged |
| Default IFC-type color table | `api/styling.rs:970` | `processor.rs:2140` | ❌ diverged (and ×2 more, §3) |
| Color numeric representation | `f32`, **quantized to `u8`** over the SAB bridge | `f32` end-to-end | ❌ diverged |
| `merge_layers` / `MaterialLayerIndex` / voids | `api/mod.rs:46–249` + `geometry` kernels | partial (`processor.rs:1864–1930`) via the **shared** geometry router | ⚠️ partial |

---

## 2. Detailed parity findings

### 2.1 `IfcIndexedColourMap` — backend has nothing
`extract_color_from_indexed_colour_map` (`styling.rs:32–78`) decodes the map, picks
the **dominant** palette index, and (since #867) `split_mesh_by_indexed_colour_map`
splits a flat `IfcTriangulatedFaceSet` into one sub-mesh **per palette group**. The
backend has **zero** references to `IFCINDEXEDCOLOURMAP` / `IFCCOLOURRGBLIST` (only
the schema type IDs exist in `core`). CATIA/3DEXPERIENCE files with no
`IFCSTYLEDITEM` (e.g. `A0513.ifc`, #663) render authored colors in the browser and
gray in the backend. Precedence to preserve: the indexed side-map only fills
geometry with **no** direct `IfcStyledItem`.

### 2.2 Default IFC-type color table — diverged in *both* directions
| IFC type | `processing` (`processor.rs:2140`) | `wasm` (`styling.rs:970`) |
|---|---|---|
| `IfcStairFlight` | `[0.75,0.75,0.75,1]` (with `IfcStair`) | **default** `[0.8,0.8,0.8,1]` |
| `IfcCurtainWall` | **default** `[0.8,0.8,0.8,1]` | `[0.5,0.7,0.9,0.5]` glass blue |
| `IfcFurnishingElement` | `[0.5,0.35,0.2,1]` dark | `[0.7,0.55,0.4,1]` light wood |
| `IfcBuildingElementProxy` | `[0.6,0.6,0.6,1]` | **default** `[0.8,0.8,0.8,1]` |

All other entries match. The wasm comment `// matches default-materials.ts` is
**stale** — no such file exists. And these are only 2 of the **5** copies (§3.1).

### 2.3 Submesh material selection — preference only in wasm
`resolve_submesh_color` (`styling.rs:828`) → `pick_material_style_for_submesh`
(`:862`) **alternates** transparent (alpha `< 0.95`) / opaque per `mat_color_idx`,
the mechanism that splits a window's glass vs frame. The backend
(`processor.rs:1428–1459`) uses one `element_color` with no alternation.

### 2.4 Material-chain resolution — wasm-only
`build_material_style_index` (`:552`), `build_element_material_styles` (`:600`),
`resolve_material_ids` (`:632`, walks `IfcMaterialList` / `IfcMaterialLayerSetUsage`
/ `IfcMaterialConstituentSet` / `IfcMaterialProfileSet`, depth-4 guard),
`flatten_material_color_index` (`:739`). The backend does none — only direct
`IfcStyledItem` + an element representation walk
(`resolve_element_color_for_product_definition_shape`, `:1572`). Material-only-styled
files (common IFC2x3 / ArchiCAD) render colored in browser, gray in backend.

### 2.5 Color representation — 8-bit quantization in the wasm bridge
Both compute `f32`; the browser quantizes to `u8` RGBA across the SAB worker
boundary (`gpu_meshes.rs:121–135`, `713–723`) and restores `c/255.0` (`:876–892`).
The backend keeps `f32` (`MeshData.color`). Browser colors round to 1/255 (~0.4%
max drift); backend is exact. A deliberate transport optimization, not a logic
difference — but the paths aren't bit-identical.

### 2.6 `merge_layers`, `MaterialLayerIndex`, voids
The kernels are **already shared** in `ifc_lite_geometry` (`material_layer_index.rs`,
`router/layers.rs` incl. `merge_thin_layers`, `void_index.rs`). The divergence is in
the **drivers**: wasm's `merge_layers` toggle + cached `parts_to_skip`
(`api/mod.rs:212–249`) vs the backend's `propagate_voids_to_aggregated_parts`
(`processor.rs:1864–1930`) — not a 1:1 mirror.

### 2.7 `IfcStyledItem` chain — close, but wasm is richer
Both resolve the chain incl. the #259 `DiffuseColour` rule. Browser-only extras:
**`IfcMappedItem` traversal** (`find_color_for_geometry`, `:83`) so mapped/instanced
geometry inherits style, and a returned **shading color** the backend drops.

---

## 3. The full blast radius (monorepo-wide)

Issue #913 frames a two-way gap. An audit (all locations verified directly) shows it
is far wider.

### 3.1 Five copies of the IFC-type → default-color table
| # | Location | Symbol | Notes |
|---|---|---|---|
| 1 | `rust/wasm-bindings/.../styling.rs:970` | `get_default_color_for_type` | browser |
| 2 | `rust/processing/.../processor.rs:2140` | `get_default_color` | backend crate |
| 3 | `apps/server/src/services/streaming.rs:690` | `get_default_color` | **3rd** copy; tracks #2 but hand-maintained |
| 4 | `apps/desktop/src-tauri/src/commands/ifc.rs:431` | `get_default_color_for_type` | **most divergent**; geometry-only dep, independent. `IfcWall` cream `[0.9,0.9,0.85,1]`, `IfcOpeningElement` white `[0.9,0.9,0.9,0.2]` vs red-orange, `IfcWindow` opaque vs transparent, ~14 types differ |
| 5 | `packages/renderer/src/section-2d-overlay.ts:69` | `IFC_TYPE_FILL_COLORS` | TS **2D drafting**, intentional but undocumented |

One model → four different default schemes (web / REST / CLI / desktop).

### 3.2 Why it recurs
- **#407** added material-chain styling to the backend and noted *"the wasm-bindings
  have the same gap … but weren't touched."* The current tree shows the **reverse**
  asymmetry — material chain now lives only in wasm. The fix didn't stay.
- **#663 / #858** fixed browser-first; #913 is the backend catching up.
- **#541** is the layered-material case. PRs **#72 / #74 / #117** ("fix colors",
  "rebuild wasm with color fixes", "colors … fixed (mostly)") are the same pattern.

Every fix lands in one consumer because **there is no shared source and no
cross-consumer test** to force the others along. Unifying the tables once, without
removing that root cause, just resets the clock.

### 3.3 Adjacent duplications with the same risk (verified)
Not all in #913's scope, but the same "share-it-or-test-it" program:
- **`IfcPresentationStyleAssignment`** IFC2x3 handling twice (`styling.rs:192` w/ a
  `// FIX:` comment vs `processor.rs:1745`).
- **Metadata type filter** — `parsing.rs:13` `is_relevant_metadata_type` is a
  hardcoded list vs schema-driven backend; new IFC types silently missed in one path.
- **Opening heuristics** — `is_opaque_opening` / `is_opening_with_subparts` /
  `infer_opening_subpart_material_name` in `processor.rs:2012+` vs the router's
  internal filtering.
- **Y-up ↔ Z-up coords** — `bcf/viewpoint.ts:83`, `bcf/ids-reporter.ts`,
  `processing/processor.rs:115`; correct today, no round-trip test.

### 3.4 What is already shared correctly (the model)
- **Symbolic / 2D extraction** — `processing/src/symbolic.rs`, wrapped by wasm,
  guarded by `processing/tests/issue_843_*`.
- **Geometry kernel** — extrusion, CSG, profiles, trimmed curves, tapered solids,
  voids, transforms, RTC, unit scale all in `ifc-lite-geometry`/`core`. This is why
  geometry fixes (#820, #853, #883, #628, #424) fix **every** consumer at once.
  Styling is the conspicuous exception.

---

## 4. Target architecture

### 4.1 The dependency constraint that decides the home crate
A single source of truth must sit **at or below the lowest crate every consumer
shares**. Reachability:

```
ifc-lite-core      ← everyone
ifc-lite-geometry  ← wasm, processing, server(via processing), desktop   ✅ common
ifc-lite-processing← wasm, server   …but NOT desktop (geometry-only)      ❌ too high
```

So the earlier "put it in `processing`" idea (and the issue's first suggestion)
**cannot reach the desktop app**. The shared home is **`core` + `geometry`**:

- **`ifc-lite-core::style`** — the *pure* pieces with no decoder/geometry:
  - `Rgba([f32;4])` canonical color type, with `to_rgba8()` / `from_rgba8()` and
    `is_transparent()` helpers (so quantization is a documented method, not ad-hoc).
  - `default_color_for_type(IfcType) -> Rgba` — the **one** table.
- **`ifc-lite-geometry::style`** — the decoder-driven resolution (needs `core`'s
  `EntityDecoder` + mesh/submesh, both already in `geometry`):
  - `StyleIndex` — built in one scan, holds direct styled items, orphan/material
    styled items, the material→colors map, and the `IfcIndexedColourMap` resolutions.
  - `IfcStyledItem` chain + `IfcMappedItem` traversal, material-`SELECT` walk,
    `resolve_element_color`, `resolve_submesh_color` (with the transparent/opaque
    rule), and the per-triangle indexed-colour split.
  - **All `f32` (`Rgba`) end-to-end.** No quantization in shared code.

`geometry` already decodes IFC entities and owns mesh emission, so IFC styling is
legitimately "geometry-specific" — exactly the issue's fallback recommendation.

### 4.2 The decisive move: color becomes part of the mesh contract
Today every consumer *re-resolves* color after meshing — which is the thing that
drifts. Instead, the **`GeometryRouter` emits already-colored submeshes**:

```rust
// geometry
let style = StyleIndex::from_content(content, decoder);          // one shared scan
let router = GeometryRouter::with_scale(scale).with_styles(&style);
let submeshes = router.process_element_with_submeshes(&entity, decoder)?;
// each SubMesh now carries `color: Rgba`, resolved by the shared resolver,
// falling back to core::default_color_for_type(ifc_type).
```

After this, consumers **do not resolve color at all** — they read `submesh.color`.
There is nothing left to duplicate, so nothing left to drift. (This mirrors how
`symbolic` returns already-colored fills/text.)

The browser keeps its streaming optimization without forking logic: the pre-pass
builds the **same** `StyleIndex`, serializes it across the SAB boundary using
`Rgba::to_rgba8`, and the worker rebuilds it with `from_rgba8` before handing it to
the router. The *only* wasm-specific code is that serialize/deserialize step.

### 4.3 Consumers after the change
| Consumer | Before | After |
|---|---|---|
| `wasm-bindings` | full styling pipeline + transport | `StyleIndex` build + `Rgba` u8 transport only; reads router colors |
| `processing` | partial styling, own default table | builds `StyleIndex`, reads router colors; **deletes** styling + table |
| `apps/server` | own `get_default_color` + some extraction | uses `processing` output; **deletes** its copy |
| `apps/desktop` | independent table on raw geometry | builds `StyleIndex` from `geometry`; **deletes** its table |
| `packages/renderer` (2D) | own `IFC_TYPE_FILL_COLORS` | **unchanged**, but annotated as an intentional 2D convention (§5.6) |

### 4.4 The hard rules (enforced, not just stated)
1. **One color table.** `core::style::default_color_for_type` is the only
   IFC-type→color map in Rust. Any other is a bug (guarded in CI, §6.3).
2. **Consumers don't resolve color.** They read `submesh.color`. No `extract_color_*`
   outside `geometry::style`.
3. **`f32` is canonical; `u8` is transport-only**, expressed solely through
   `Rgba::to_rgba8`/`from_rgba8`.
4. **`wasm-bindings` is a thin platform layer** — FFI, JS wrappers, SAB/streaming
   transport. No styling decisions.

---

## 5. Migration plan

Each phase is independently shippable, reversible, and lands with its tests.
Phase 0 first so every later refactor is provably behavior-preserving.

### Phase 0 — Baseline harness (no behavior change)
- Add the cross-consumer parity test crate/harness (§6) and **golden fixtures**,
  asserting *current* output of each path. This captures today's behavior (including
  the divergences) as a baseline, so subsequent phases show exactly what changed.
- Add `core::style::{Rgba, default_color_for_type}` (table = the agreed union, §8.1)
  but **don't wire it in yet** — just unit-test it.

### Phase 1 — Unify the default-color table *(low risk)*
- Repoint **all four** Rust copies (#1–#4 in §3.1) to `core::style::default_color_for_type`.
  Delete the four bodies and the stale `default-materials.ts` comment.
- Land the **"no second table" CI guard** (§6.3) in the same PR — this is what makes
  Phase 1 *stick*.
- Behavioral change for `apps/desktop` (14 types) and the four contested types
  elsewhere; snapshots updated in-PR; documented in the changeset/PR body.

### Phase 2 — Shared resolver in `geometry::style`
- Lift the wasm extraction (§2.1, §2.3, §2.4, §2.7) into `geometry::style` as
  `StyleIndex` + resolvers, `Rgba`-pure, **preserving `IfcStyledItem`-wins
  precedence** over the indexed side-map.
- Wire `GeometryRouter::with_styles` so `process_element_with_submeshes` emits
  colored submeshes (§4.2).
- Backend now gains `IfcIndexedColourMap` + material chain → fixes #663 and the #407
  regression. Per-triangle split included or dominant-only — **decision §8.2**.

### Phase 3 — Consumers go thin
- `processing`, `apps/server`, `apps/desktop` drop all color resolution and read
  `submesh.color`. `wasm-bindings` re-points to the shared `StyleIndex`, keeping only
  the `Rgba` u8 SAB transport.
- Net: hundreds of lines deleted across four consumers; one implementation remains.

### Phase 4 — Reconcile `merge_layers` / void drivers (§2.6)
- Factor the layer/void *driver* (parts-to-skip when parent sliceable; void
  propagation to aggregated parts) into a shared `geometry`/`processing` helper used
  by both `api/mod.rs` and `processor.rs`.

### Phase 5 — Quantization contract (§2.5)
- Express the browser's 8-bit step only via `Rgba::to_rgba8`/`from_rgba8`; document
  that browser colors round to 1/255 and the backend stays exact (the parity test
  uses a 1/255 tolerance for the wasm path, 0 elsewhere). **Decision §8.3** on whether
  to instead widen the SAB transport to `f32`.

### Phase 6 — 2D table + adjacent dups *(follow-up issue)*
- Annotate `IFC_TYPE_FILL_COLORS` as an intentional 2D convention; optionally
  generate it from a shared export so even the deliberate offset is traceable.
- Open a separate issue for the §3.3 adjacencies (style-assignment, metadata filter,
  opening heuristics, coordinate conversion) — same root cause, different surface.

---

## 6. Anti-regression system — *the answer to "not here again in 3 months"*

Unifying code is necessary but not sufficient; #407 proves a one-time fix erodes.
Four layers, in increasing durability:

### 6.1 Structural (can't drift)
The single source of truth (§4.1) + colored-mesh contract (§4.2). Once consumers
read `submesh.color`, there is **no second place** to put a color decision. This is
the primary defense; everything below is backstop.

### 6.2 Golden parity test (catches logic drift)
A Rust integration test (new `rust/parity/` test crate, or
`geometry/tests/styling_parity.rs`) that, for each fixture:
- builds the `StyleIndex` and runs the shared resolver, and
- asserts per-geometry colors against a checked-in expectation, **and**
- asserts the `wasm-bindings` extraction path and the `processing` path produce the
  **same** colors (wasm within the 1/255 tolerance, others exact).

This is precisely what `symbolic` has (`tests/issue_843_*`) and styling lacks.
Fixtures (one per failure mode, each a tiny IFC):
- `A0513`-style `IfcIndexedColourMap` (no styled item) — #663.
- 12-tri per-triangle cube — #858.
- window with frame+glazing materials — #407 / §2.3.
- material-only-styled wall (IFC2x3) — §2.4.
- layered wall with an opening — §2.6.
- a model touching all contested default types — §2.2.

### 6.3 "No second table" CI guard (catches new copies)
A test (or `scripts/` lint run in CI) that scans Rust sources and **fails** if an
IFC-type→color table appears outside `core::style`. Concretely: grep for a
`get_default_color`-style signature or an `IfcType::Ifc... => [` color-literal
pattern; allow exactly the canonical module and the explicitly-marked 2D table
(`// PARITY-ALLOW: intentional 2D drafting palette`). This is the tripwire that
would have caught copies #3 and #4 the day they were added.

### 6.4 Process / docs (catches intent)
- **`AGENTS.md` rule** (new bullet under §1 Schema Compliance or a new "Styling"
  section): *"Default colors and style resolution have exactly one home
  (`core::style` + `geometry::style`). Never add a per-consumer color table or
  `extract_color_*`. A new IFC-type default = edit the one table **and** extend the
  parity fixture. The 2D drafting palette is the only sanctioned exception and must
  carry the `PARITY-ALLOW` marker."*
- This document, linked from the rule, as the rationale (ADR-style).
- PR-review checklist item: "touches color? → one table, parity fixture updated."

---

## 7. Test & verification strategy
- The §6.2 golden harness is the backbone; add to it before fixing each gap.
- Reuse the CSG fidelity patterns in `docs/research/csg-clipping-fidelity.md`.
- Manual: load each fixture in the web viewer **and** via `ifc-lite` CLI export and
  confirm matching colors (the verify/run skills can drive this).
- Definition of done (acceptance):
  1. `A0513.ifc` renders authored colors in **all four** consumers.
  2. The four contested default types and the ~14 desktop types are identical
     everywhere (or the desktop palette is explicitly ratified as intentional, §8.4).
  3. Only one Rust color table exists; the CI guard is green.
  4. The parity test fails if any consumer's color resolution diverges.

---

## 8. Decisions required (surface to maintainer)
1. **Canonical default colors** for the four contested types (§2.2). Recommend the
   **union** of the wasm + processing tables (no type loses an authored default).
2. **Backend per-triangle indexed-colour fidelity** (§2.1): full per-triangle split
   (as browser since #867) or dominant-color-per-faceset? Recommend full split for
   true parity.
3. **Quantization** (§2.5/§5): document 8-bit as browser-transport-only (recommended;
   drift is sub-0.4% and invisible after GPU 8-bit anyway), or widen SAB to `f32`.
4. **Desktop palette** (§3.1 #4): is the cream/white-opening scheme an intentional
   desktop aesthetic, or drift? Recommend treating as drift and unifying; if
   intentional, it must become an explicit, `PARITY-ALLOW`-marked theme, not a buried
   table.

These are product/fidelity calls; confirm rather than assume. None block Phase 0.

---

## 9. Risks, rollout, ownership
- **Behavioral change** is the point, not a side effect: Phase 1 changes backend and
  desktop colors for several types. Land each phase with snapshot updates and a clear
  changeset/PR note. Roll out phase-by-phase so any regression is bisectable to one
  small PR.
- **Don't regress the wasm pre-scan budget**: `StyleIndex::from_content` must stay a
  single allocation-light scan; the shared resolvers must be `Rgba`-pure. Benchmark
  the pre-pass on a large file before/after Phase 3.
- **`geometry` file-size** (`AGENTS.md §7`, ~400 lines): `geometry::style` is its own
  module dir (`geometry/src/style/{mod,index,resolve,indexed_colour}.rs`), not bolted
  onto the router. Same for `processing` — never grow the 2.2k-line `processor.rs`.
- **Changeset**: if any published `packages/*` surface changes (unlikely — this is
  Rust-internal), add one per `AGENTS.md §3`; the bump must match the biggest API
  change. Revert the generated `packages/wasm/pkg/{README.md,package.json}` churn
  before committing.
- **Ownership**: geometry/processing core owns Phases 0–4; the desktop change in
  Phase 1/3 needs a desktop maintainer's sign-off on decision §8.4.
- **Sizing (rough)**: P0 ~1d (harness+fixtures), P1 ~0.5d, P2 ~2–3d (the real lift,
  porting + per-triangle split + router wiring), P3 ~1–2d (deletions + wasm
  transport), P4 ~1d, P5 ~0.5d, P6 follow-up. The guard rails (§6.2–6.4) are inside
  P0/P1, not extra.
