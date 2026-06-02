# IFC Styling & Default-Rendering Parity — Research & Plan

Status: **proposed** (research complete; implementation not started).
Owner: geometry / processing core.
Tracking: [#913](https://github.com/LTplus-AG/ifc-lite/issues/913).
Related: `docs/architecture/rendering-pipeline.md`, `docs/architecture/geometry-pipeline.md`.

This document is the *what/why* of closing the styling gap between the two Rust
rendering paths. It is research + a phased plan, not a record of shipped work.

---

## 0. Problem statement

ifc-lite has **two Rust paths that produce colored meshes from the same IFC file**:

- **Browser** — `rust/wasm-bindings` (`src/api/styling.rs`, `src/api/gpu_meshes.rs`),
  streaming pre-pass → worker batches → GPU.
- **Backend** — `rust/processing` (`src/processor.rs`), CPU pipeline used by the
  CLI, server, MCP, and headless tooling.

They are **not rendering-equivalent today**. The same file can render with
authored colors in the browser and fallback defaults in the backend, and the
default colors themselves differ for several IFC types. The root cause is
structural: **the styling/color logic was duplicated into each crate instead of
shared**, and the two copies have drifted.

Note: `symbolic` extraction (2D curves, fills, grid bubbles, annotation colors)
is *not* part of this gap — it already lives in the shared
`ifc_lite_processing::symbolic` module and is consumed by both paths. This plan
is about **3D geometry styling and default mesh colors only**.

---

## 1. Where styling lives today

| Concern | Browser (`wasm-bindings`) | Backend (`processing`) | Shared? |
|---|---|---|---|
| `IfcStyledItem` chain → `IfcSurfaceStyle` → `IfcColourRgb` | `api/styling.rs:134–325` | `processor.rs:1504–1849` | ❌ duplicated |
| `IfcIndexedColourMap` / `IfcColourRgbList` | `api/styling.rs:23–78` (+ per-triangle split in `api/gpu_meshes.rs`) | **absent** | ❌ wasm-only |
| Material chain (orphan `IfcStyledItem`, material `SELECT` walk) | `api/styling.rs:552–821` | **absent** | ❌ wasm-only |
| Submesh color resolution + transparent/opaque preference | `api/styling.rs:828–890` | `processor.rs:1428–1459` | ❌ diverged |
| Default IFC-type color table | `api/styling.rs:970–1019` | `processor.rs:2140–2187` | ❌ diverged |
| Color numeric representation | `f32` internally, **quantized to `u8` RGBA** across the SAB bridge (`api/gpu_meshes.rs:121–135, 713–723`, restored `876–892`) | `f32` end-to-end | ❌ diverged |
| `merge_layers` / `MaterialLayerIndex` / void propagation | `api/mod.rs:46–249` + `geometry/src/router/layers.rs` + `geometry/src/void_index.rs` | partial (`processor.rs:1864–1930`) via the **shared** geometry router | ⚠️ partial |

Symbolic, by contrast, is the model to follow: `processing/src/symbolic.rs` is the
single source, and `wasm-bindings/src/api/symbolic.rs` is a thin wrapper that
calls `ifc_lite_processing::extract_symbolic_data` and adapts the result to the
`wasm_bindgen` types.

---

## 2. Detailed parity findings

### 2.1 `IfcIndexedColourMap` — backend has nothing

- **Browser**: `extract_color_from_indexed_colour_map` (`styling.rs:32–78`) decodes
  `IfcIndexedColourMap` (`MappedTo`, `Opacity`, `Colours → IfcColourRgbList`,
  `ColourIndex`). It picks the **dominant** palette index via a histogram (single
  index → that index). Additionally, since #867, `split_mesh_by_indexed_colour_map`
  (`gpu_meshes.rs`) partitions a flat-shaded `IfcTriangulatedFaceSet` into one
  sub-mesh **per palette group**, so per-triangle authored colors render correctly.
- **Backend**: grep finds **zero** references to `IfcIndexedColourMap`,
  `IFCINDEXEDCOLOURMAP`, or `IFCCOLOURRGBLIST` in `rust/processing`. The schema type
  IDs exist in `core/src/generated/schema.rs` (`IFCINDEXEDCOLOURMAP = 3570813810`,
  `IFCCOLOURRGBLIST = 3285139300`) but nothing consumes them.
- **Effect**: CATIA / 3DEXPERIENCE exports (e.g. `A0513.ifc` from #663) that color
  via `IFCINDEXEDCOLOURMAP` with no `IFCSTYLEDITEM` chain render authored colors in
  the browser and **off-white/gray defaults** in the backend. This is the clearest
  regression and the minimum bar for the fix.
- **Precedence to preserve**: in wasm, the indexed-colour side-map only fills
  geometry that has **no** direct `IfcStyledItem` (`styling.rs` pre-pass ~`495–500`).
  `IfcStyledItem` wins.

### 2.2 Default IFC-type color table — diverged in *both* directions

The two `match` tables are mostly identical but differ on four types. Each crate
has entries the other lacks, so this is genuine drift, not "backend is behind":

| IFC type | `processing` (`processor.rs:2140`) | `wasm-bindings` (`styling.rs:970`) |
|---|---|---|
| `IfcStairFlight` | `[0.75, 0.75, 0.75, 1.0]` (grouped with `IfcStair`) | **falls to default** `[0.8, 0.8, 0.8, 1.0]` |
| `IfcCurtainWall` | **falls to default** `[0.8, 0.8, 0.8, 1.0]` | `[0.5, 0.7, 0.9, 0.5]` (glass blue) |
| `IfcFurnishingElement` | `[0.5, 0.35, 0.2, 1.0]` (dark brown) | `[0.7, 0.55, 0.4, 1.0]` (light wood) |
| `IfcBuildingElementProxy` | `[0.6, 0.6, 0.6, 1.0]` | **falls to default** `[0.8, 0.8, 0.8, 1.0]` |

All other entries match. The wasm function carries a stale comment
`// matches default-materials.ts`; **no such TS file exists today** — the only two
sources of truth are these two Rust functions.

### 2.3 Submesh material selection — transparent/opaque preference only in wasm

- **Browser** `resolve_submesh_color` (`styling.rs:828`) → on material fallback,
  `pick_material_style_for_submesh` (`styling.rs:862`) **alternates**: even
  `mat_color_idx` prefers transparent (alpha `< 0.95`), odd prefers opaque
  (`TRANSPARENCY_ALPHA_THRESHOLD = 0.95`). This is how a window with frame (opaque)
  + glazing (transparent) materials distributes colors across its sub-meshes.
- **Backend**: `processor.rs:1428–1459` looks up the per-submesh `geometry_id` style,
  else falls back to a single `element_color`. **No material-color vector and no
  transparent/opaque alternation.**

### 2.4 Material-chain resolution — wasm-only

The browser pre-pass resolves colors that live on **materials**, not geometry:
`build_material_style_index` (`styling.rs:552`), `build_element_material_styles`
(`600`), `resolve_material_ids` (`632`, walks `IfcMaterialList` /
`IfcMaterialLayerSetUsage` / `IfcMaterialConstituentSet` / `IfcMaterialProfileSet`
with a depth-4 guard), and `flatten_material_color_index` (`739`, one opaque color
per material). The backend does **none** of this — it only reads direct
`IfcStyledItem` on geometry plus an element-level representation color walk
(`resolve_element_color_for_product_definition_shape`, `processor.rs:1572`).

### 2.5 Color representation — 8-bit quantization in the wasm bridge

Both crates compute colors as `f32` in `[0,1]`. The **browser** then quantizes to
`u8` RGBA to cross the SharedArrayBuffer worker boundary
(`gpu_meshes.rs:121–135` and `713–723`, `(c * 255.0).clamp(0,255) as u8`) and
restores `c as f32 / 255.0` in the worker (`876–892`). The **backend** keeps `f32`
throughout (`MeshData.color: [f32;4]`, serde JSON). Result: browser colors are
rounded to 1/255 steps; backend colors are exact. For most authored colors this is
invisible, but non-integer RGB and partial transparency can drift by up to ~0.4%.
This is a **deliberate transport optimization in wasm**, not a styling-logic
difference — but it does mean the two paths are not bit-identical.

### 2.6 `merge_layers`, `MaterialLayerIndex`, voids

The heavy lifting here is already in the **shared** `ifc_lite_geometry` crate:
`material_layer_index.rs` (buildup detection / sliceability), `router/layers.rs`
(per-layer slicing, `merge_thin_layers` folding sub-2mm layers, voids subtracted
*before* slicing), and `void_index.rs::propagate_voids_to_parts`. The divergence is
in the **drivers**: wasm has a `merge_layers` `AtomicBool` toggle and a cached
`parts_to_skip` set (`api/mod.rs:212–249`) that suppresses
`IfcBuildingElementPart` emission when the parent wall is sliceable; the backend's
equivalent (`processor.rs:1864–1930` `propagate_voids_to_aggregated_parts`) is not
a 1:1 mirror. Layered walls and aggregated parts can therefore diverge in coloring
and cut behavior even when no indexed colour map is involved.

### 2.7 `IfcStyledItem` chain — close, but wasm is richer

Both resolve `IfcStyledItem → (IfcPresentationStyleAssignment) → IfcSurfaceStyle →
IfcSurfaceStyleRendering → IfcColourRgb`, including the #259 `DiffuseColour`
handling (RGB diffuse stored as shading override, not rendered; ratio diffuse
modulates surface color). Two browser-only extras: **`IfcMappedItem` traversal**
(`find_color_for_geometry`, `styling.rs:83`) follows `IfcRepresentationMap` so
mapped/instanced geometry inherits style, and the browser returns a **shading
color** alongside the rendering color; the backend keeps only one color.

---

## 3. Root cause & target architecture

**Root cause:** styling is presentation logic that was implemented twice. Symbolic
extraction avoided this by living in `processing` and being wrapped by wasm; styling
did not, because the wasm path grew around a heavily optimized single-pass pre-scan
and the backend re-implemented the pieces it needed inline.

**Target (mirrors the symbolic split and the issue's "Optional Recommendation"):**

```
ifc-lite-core        schema, decoder, IfcType            (unchanged)
ifc-lite-geometry    mesh/CSG, layers, voids             (already shared)
ifc-lite-processing  ── NEW: styling module ─────────────────────────────┐
                     • canonical default-color table                      │
                     • IfcStyledItem chain + MappedItem traversal          │ one
                     • IfcIndexedColourMap / IfcColourRgbList resolution    │ source
                     • material-chain resolution                           │ of
                     • submesh color resolution + transparent/opaque rule  │ truth
                     • all colors f32 end-to-end                           │
ifc-lite-wasm        thin layer: pre-pass scan plumbing, SAB/u8 transport, ┘
                     JS wrappers — calls into processing::styling
```

The hard rule (as with `symbolic` and `clash`): **canonical styling decisions live
in `processing` (or lower in `geometry` when purely geometric); `wasm-bindings`
keeps only the FFI boundary, the streaming/SAB transport, and JS wrappers.**

---

## 4. Phased plan

Ordered so each phase is independently shippable and testable, smallest
user-visible regression first.

### Phase 1 — Unify the default-color table *(low risk, high clarity)*
- Add `processing::styling::default_color_for_type(&IfcType) -> [f32;4]` as the
  single source of truth.
- Reconcile the four diverging types (see §2.2). **Decision required** (§5): pick
  one value per type. Recommended canonical set: keep wasm's `IfcCurtainWall`
  (glass blue) and `IfcFurnishingElement` (light wood), keep processing's
  `IfcStairFlight` (= `IfcStair` gray) and `IfcBuildingElementProxy` (`0.6` gray),
  i.e. the **union** of both tables — no type loses an authored default.
- Replace both `get_default_color` / `get_default_color_for_type` bodies with calls
  into the shared fn. Delete the stale `default-materials.ts` comment.
- Test: table-driven unit test asserting every mapped type is identical across the
  shared fn; snapshot both paths on a fixture covering all four contested types.

### Phase 2 — Move `IfcStyledItem` + `IfcIndexedColourMap` + material chain into `processing`
- Lift the wasm color-extraction functions (§2.1, §2.4, §2.7) into
  `processing::styling` as pure functions over `EntityDecoder`, **preserving the
  `IfcStyledItem`-wins precedence** over the indexed-colour side-map.
- Keep `f32` throughout; do not introduce quantization in the shared code.
- Re-point `wasm-bindings` to the shared functions; its pre-pass keeps only the
  scan/iteration + SAB packing.
- Add `IfcIndexedColourMap` resolution to the backend processor so `A0513.ifc`
  (#663) renders authored colors. Include the per-triangle split path (port
  `split_mesh_by_indexed_colour_map`) or, at minimum, the dominant-color path —
  **decision required** (§5) on whether the backend needs per-triangle fidelity.
- Test: `A0513.ifc` backend snapshot now shows palette colors, not gray; a
  per-triangle fixture (the #858 12-tri cube) shows ≥2 color groups if per-triangle
  is in scope.

### Phase 3 — Align submesh material selection
- Move `resolve_submesh_color` + `pick_material_style_for_submesh` (incl. the
  `mat_color_idx` alternation and `0.95` threshold) into `processing::styling`; use
  it from both paths so windows/curtain walls distribute frame/glass colors
  identically.
- Test: a window fixture with frame+glazing materials produces the same per-submesh
  color sequence in both paths.

### Phase 4 — Reconcile `merge_layers` / void propagation drivers
- Factor the layer/void *driver* (parts-to-skip when parent is sliceable;
  void propagation to aggregated parts) into a shared helper in `geometry` or
  `processing`, consumed by both `api/mod.rs` and `processor.rs`.
- Test: a layered wall with a window opening renders the same layer sub-meshes and
  the same cut in both paths.

### Phase 5 — Decide the quantization contract *(documentation / optional)*
- Either (a) accept 8-bit quantization as a browser-transport-only concern and
  **document** that browser colors are rounded to 1/255 (backend stays exact), or
  (b) widen the SAB transport to `f32` (4× the style-color payload; styles are a
  small fraction of total mesh bytes, so cost is likely negligible).
- **Decision required** (§5). Recommended: (a) document it — the drift is sub-0.4%
  and invisible after GPU 8-bit framebuffer quantization anyway.

---

## 5. Decisions required (surface to maintainer before/within implementation)

1. **Canonical default colors** for the four contested types (§2.2). Recommended:
   union of both tables (no type loses a default).
2. **Backend per-triangle indexed-colour fidelity** (§2.1/Phase 2): full per-triangle
   split, or dominant-color-per-faceset only? Browser does full split since #867.
3. **Quantization contract** (§2.5/Phase 5): document 8-bit as browser-only, or move
   the SAB transport to `f32`?

These are product/fidelity calls, not mechanical ones, so they should be confirmed
rather than assumed.

---

## 6. Test & verification strategy

- **Golden fixtures**, one per gap: `A0513.ifc` (#663, indexed colour map), the
  #858 per-triangle cube, a curtain-wall/window frame+glazing model, a layered wall
  with an opening, and a model exercising all four contested default types.
- **Cross-path equality harness**: a Rust integration test that runs the same
  fixture through `processing` and through the `wasm-bindings` extraction functions
  and asserts per-geometry colors match (modulo the documented quantization
  tolerance from §5.3). This harness is the regression guard against future drift —
  it is what was missing.
- Reuse existing CSG/geometry fidelity patterns from `docs/research/csg-clipping-fidelity.md`.

---

## 7. Risks & notes

- **Behavioral change for existing files**: unifying defaults will change backend
  colors for `IfcCurtainWall` / `IfcBuildingElementProxy` / `IfcStairFlight` /
  `IfcFurnishingElement` and browser colors for whichever side loses a contested
  value. This is the intended fix but should land with the snapshot updates in the
  same PR.
- **`wasm-bindings` slimming** must not regress the single-pass pre-scan performance
  characteristics; the shared functions should be `f32`-pure and allocation-light so
  the wasm pre-pass keeps its one-scan budget.
- **Changeset**: if any published `packages/*` surface changes (it likely won't —
  this is Rust-internal), add a changeset per `AGENTS.md §3`. WASM rebuild churn in
  `packages/wasm/pkg/{README.md,package.json}` must be `git checkout`-reverted before
  commit per `AGENTS.md §3`.
- **File-size rule** (`AGENTS.md §7`, ~400 lines): the new `processing` styling code
  should be its own module (`processing/src/styling/…`), not appended to the already
  2.2k-line `processor.rs`.
