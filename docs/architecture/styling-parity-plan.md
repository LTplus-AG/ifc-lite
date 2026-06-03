# IFC Styling & Default-Rendering Parity — Research & Plan

Status: **Phases 0–1 + 2a + 2b(per-triangle) landed.** Canonical
`ifc_lite_processing::style` module is the single default-color table (consumed by
`processing`, `wasm-bindings`, `apps/server`; CI guard forbids new copies), and the
backend now resolves `IfcIndexedColourMap` — both dominant colour (#663) **and
per-triangle splitting** (#858). Remaining Phase 2: material chain (#407), submesh
transparent/opaque preference, and pointing `wasm-bindings` at the shared resolver.
Owner: geometry / processing core.
Tracking: [#913](https://github.com/LTplus-AG/ifc-lite/issues/913).
Related: `docs/architecture/rendering-pipeline.md`, `docs/architecture/geometry-pipeline.md`,
`docs/architecture/clash-detection-plan.md` (the "one shared core" precedent).

This is the *what/why* of closing the styling gap between every live rendering path
in the repo, **and** the structural changes that stop it reopening. It is research +
a phased plan + an anti-regression design, not a record of shipped work.

> **Update:** the Tauri **desktop app is being discontinued**. That removes the most
> divergent copy of the color table (§3.1 #4) outright, and — because every
> *remaining* consumer depends on `ifc-lite-processing` — makes `processing` the
> natural shared home (§4.1), exactly where `symbolic` already lives. The plan below
> reflects this.

---

## 0. Problem statement

ifc-lite turns one IFC file into colored meshes in several independent Rust
consumers, plus a TypeScript 2D path:

- **Browser** — `rust/wasm-bindings` (streaming pre-pass → worker → GPU).
- **Backend crate** — `rust/processing` (the shared CPU pipeline).
- **REST/stream server** — `apps/server` (depends on `processing`, but keeps its own color code).
- ~~**Desktop (Tauri)** — `apps/desktop`~~ — **being discontinued**; removed, not migrated.
- **2D drafting** — `packages/renderer` (TypeScript, intentionally its own palette).

The live consumers are **not rendering-equivalent today**. The same file renders
authored colors in the browser and fallback gray in the backend; default colors
differ per type. Root cause is structural: **color logic was copied into each
consumer instead of shared**, and the copies drifted (§3).

`symbolic` extraction is *not* part of this gap — it already lives in the shared
`ifc_lite_processing::symbolic` module with a parity test, and is wrapped by the
browser. **It is the exact template this plan follows for styling.**

---

## 1. Where styling lives today

| Concern | Browser (`wasm-bindings`) | Backend (`processing`) | Shared? |
|---|---|---|---|
| `IfcStyledItem` chain → `IfcSurfaceStyle` → `IfcColourRgb` | `api/styling.rs:134–325` | `processor.rs:1504–1849` | ❌ duplicated |
| `IfcIndexedColourMap` / `IfcColourRgbList` | `api/styling.rs:23–78` (+ per-triangle split in `api/gpu_meshes.rs`) | **absent** | ❌ wasm-only |
| Material chain (orphan `IfcStyledItem`, material `SELECT` walk) | `api/styling.rs:552–821` | **absent** | ❌ wasm-only |
| Submesh color + transparent/opaque preference | `api/styling.rs:828–890` | `processor.rs:1428–1459` | ❌ diverged |
| Default IFC-type color table | `api/styling.rs:970` | `processor.rs:2140` | ❌ diverged (+ server, §3) |
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
**stale** — no such file exists. `apps/server` carries a third copy (§3.1).

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

## 3. The full blast radius

Issue #913 frames a two-way gap. An audit (all locations verified directly) shows it
is wider — though discontinuing desktop closes part of it for free.

### 3.1 Copies of the IFC-type → default-color table
| # | Location | Symbol | Status |
|---|---|---|---|
| 1 | `rust/wasm-bindings/.../styling.rs:970` | `get_default_color_for_type` | migrate → shared |
| 2 | `rust/processing/.../processor.rs:2140` | `get_default_color` | becomes the shared home |
| 3 | `apps/server/src/services/streaming.rs:690` | `get_default_color` | migrate → shared |
| 4 | `apps/desktop/src-tauri/src/commands/ifc.rs:431` | `get_default_color_for_type` | **deleted with the discontinued app** (was most divergent: cream walls, white openings, ~14 types) |
| 5 | `packages/renderer/src/section-2d-overlay.ts:69` | `IFC_TYPE_FILL_COLORS` | TS **2D drafting** — keep, annotate as intentional |

After desktop is gone, the live Rust copies to unify are #1–#3, all of which depend
on `processing`.

### 3.2 Why it recurs
- **#407** added material-chain styling to the backend and noted *"the wasm-bindings
  have the same gap … but weren't touched."* The current tree shows the **reverse**
  asymmetry — material chain now lives only in wasm. The fix didn't stay.
- **#663 / #858** fixed browser-first; #913 is the backend catching up.
- **#541** is the layered-material case. PRs **#72 / #74 / #117** ("fix colors",
  "rebuild wasm with color fixes", "colors … fixed (mostly)") are the same pattern.

Every fix lands in one consumer because **there is no shared source and no
cross-consumer test** to force the others along. Unifying once, without removing that
root cause, just resets the clock.

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
- **Symbolic / 2D extraction** — `processing/src/symbolic.rs`, wrapped by
  `wasm-bindings/src/api/symbolic.rs`, guarded by `processing/tests/issue_843_*`.
- **Geometry kernel** — extrusion, CSG, profiles, trimmed curves, tapered solids,
  voids, transforms, RTC, unit scale all in `ifc-lite-geometry`/`core`. This is why
  geometry fixes (#820, #853, #883, #628, #424) fix **every** consumer at once.
  Styling is the conspicuous exception.

---

## 4. Target architecture

### 4.1 Home crate — now unambiguous: `processing`
With desktop discontinued, every live consumer shares `processing`:

```
live consumers:   wasm-bindings,  processing,  apps/server
core       ← all
geometry   ← all
processing ← wasm-bindings, apps/server, (itself)     ✅ shared by every live consumer
```

So the issue's original recommendation holds, and it matches the proven `symbolic`
split exactly. **Styling moves into a new `ifc_lite_processing::style` module, a
sibling of `symbolic`.** No new crate; the geometry router stays color-agnostic
(color is a presentation concern that sits above the mesh kernel).

`processing::style` owns **all** of it:
- `Rgba([f32;4])` canonical color type with `to_rgba8()` / `from_rgba8()` /
  `is_transparent()` (so quantization is a documented method, not ad-hoc).
- `default_color_for_type(IfcType) -> Rgba` — the **one** table.
- `StyleIndex` — built in one content scan: direct + orphan/material styled items,
  the material→colors map, and the `IfcIndexedColourMap` resolutions.
- the resolvers: `IfcStyledItem` chain + `IfcMappedItem` traversal, material-`SELECT`
  walk, indexed-colour (incl. per-triangle split), and a **single batch entry point**
  (below).
- **`Rgba`/`f32` end-to-end.** No quantization inside the shared code.

(The pure `default_color_for_type` table *could* sink into `core` if a sub-processing
consumer ever needs it; today nothing does, so keeping the whole styling story in one
module — like `symbolic` — wins on cohesion. YAGNI.)

### 4.2 The decisive move: one batch resolver owns every color decision
Today each consumer re-runs its own resolution loop — and the per-submesh
transparent/opaque alternation (the `mat_color_idx` counter, §2.3) is *stateful*, so
even two correct re-implementations can disagree on iteration order. The fix is a
single shared entry point that resolves a whole element at once and owns that state
internally:

```rust
// processing::style
let styles = StyleIndex::from_content(content, decoder);     // one shared scan
// …per element, after the geometry router returns submeshes:
let colors: Vec<Rgba> =
    styles.resolve_element_submesh_colors(ifc_type, &submeshes, decoder);
//   ^ owns: direct style → indexed map → material chain → transparent/opaque
//     alternation → element color → default_color_for_type, in ONE place.
```

Every consumer calls this; none re-implements the precedence or the counter. There is
no second place to put a color decision, so nothing can drift.

The browser keeps its streaming optimization **without forking logic**: the pre-pass
builds the same `StyleIndex`, serializes it across the SAB boundary via
`Rgba::to_rgba8`, and the worker rebuilds it with `from_rgba8` before calling the
same `resolve_element_submesh_colors`. That serialize/deserialize is the *only*
wasm-specific styling code that remains.

### 4.3 Consumers after the change
| Consumer | Before | After |
|---|---|---|
| `processing` | partial styling + own default table | **owns** `processing::style`; calls the batch resolver |
| `wasm-bindings` | full styling pipeline + transport | builds `StyleIndex` via `processing::style`, `Rgba` u8 SAB transport, calls the batch resolver in the worker; **deletes** `api/styling.rs` styling logic |
| `apps/server` | own `get_default_color` + some extraction | uses `processing` output; **deletes** its copy |
| `apps/desktop` | independent table | **deleted** with the app |
| `packages/renderer` (2D) | own `IFC_TYPE_FILL_COLORS` | **unchanged**, annotated as an intentional 2D convention (§5.6) |

This is the same shape as `symbolic`: one `processing` module, a thin wasm wrapper,
everyone else downstream.

### 4.4 The hard rules (enforced, not just stated — see §6)
1. **One color table.** `processing::style::default_color_for_type` is the only
   IFC-type→color map in Rust. Any other is a bug (CI guard, §6.3).
2. **Consumers don't resolve color.** They call `resolve_element_submesh_colors` /
   read its result. No `extract_color_*` outside `processing::style`.
3. **`f32`/`Rgba` is canonical; `u8` is transport-only**, via `to_rgba8`/`from_rgba8`.
4. **`wasm-bindings` is a thin platform layer** — FFI, JS wrappers, SAB/streaming
   transport. No styling decisions. (Same rule `symbolic` already follows.)

---

## 5. Migration plan

Each phase is independently shippable, reversible, and lands with its tests.
Phase 0 first so every later refactor is provably behavior-preserving.

### Phase 0 — Baseline + scaffold (no behavior change) — **done**
- ✅ Added `processing::style::{Rgba, default_color_for_type, TRANSPARENCY_ALPHA_THRESHOLD}`
  (`rust/processing/src/style/mod.rs`) — the canonical color type and the agreed
  **union** table (§8.1), with unit tests. Re-exported from `lib.rs`; **not wired into
  the pipeline** yet.
- ✅ Added `rust/processing/tests/styling_parity.rs` — a **baseline lock** that
  snapshots both historical tables and proves the union changes *exactly* four
  entries (`exactly_four_types_change_per_table`), so Phase 1's deletions are
  provably intentional.
- ⏭️ **Deferred to Phase 2:** the end-to-end golden IFC fixtures comparing the wasm
  vs processing *mesh* output (§6.2). They need the shared decoder-driven resolver
  to compare against, which doesn't exist until Phase 2; today the default-color
  table is the only shared styling surface, and it is locked at unit level above.

### Phase 1 — Unify the default-color table *(low risk)* — **done**
- ✅ Repointed the three live Rust copies to
  `ifc_lite_processing::default_color_for_type(..).to_array()` and **deleted** their
  bodies: `processing` (`processor.rs`), `wasm-bindings` (`api/styling.rs`, call
  sites in `api/gpu_meshes.rs`), `apps/server` (`services/streaming.rs`). Removed the
  stale `// matches default-materials.ts` comment.
- ✅ Landed the **"no second table" CI guard** as a self-contained test
  (`tests/styling_parity.rs::no_duplicate_default_color_tables`) — scans `rust/` and
  `apps/` and fails on any `fn get_default_color*` outside `processing::style`. Runs
  under `cargo test`; no workflow edits needed.
- 🔸 **Copy #4 (desktop) is allowlisted, not deleted here.** Removing the whole
  discontinued app is out of scope for a styling PR; the guard allowlists
  `apps/desktop/` with a `#913` note so it is removed when the app is decommissioned.
  (Desktop is geometry-only, so its colors are simply stale until then — no live web
  or server path uses it.)
- Behavioral change: backend/server now match the canonical union for the four
  contested types; `tests/styling_parity.rs` proves only those four changed.

### Phase 2 — Shared resolver in `processing::style`

**Phase 2a — backend `IfcIndexedColourMap` (dominant colour) — done**
- ✅ `processing::style::indexed_colour::resolve_indexed_colour_map` ports the browser
  extractor (`Rgba`-pure). The processor collects `IFCINDEXEDCOLOURMAP` during its
  scan into a `geometry_id → colour` index and folds it into `geometry_style_index`
  via `merge_indexed_colours` — `or_insert`, so **`IfcStyledItem` still wins** (the
  side-map only fills geometry with no direct style). Every existing color consumer
  (element-color resolution, submesh path, `is_opaque_opening`) picks it up with zero
  threading.
- ✅ Fixes #663: `tests/styling_indexed_colour.rs` proves an `IfcBuildingElementProxy`
  whose only colour source is an indexed colour map now renders the authored colour,
  not the default gray.

**Phase 2b — per-triangle indexed-colour split — done**
- ✅ `resolve_indexed_colour_map_full` now returns the palette + a per-triangle index
  (`FullIndexedColourMap`), and `split_mesh_by_indexed_colour` partitions a flat-shaded
  face set into one sub-mesh per palette group. The processor collects the full map in
  the same scan, and the single-mesh emission path splits when an element's face set
  has a multi-colour map **and** the produced triangle count still matches `CoordIndex`
  (a count mismatch = CSG/void retopology → keep the dominant-coloured mesh).
- ✅ Fixes #858: `tests/styling_indexed_colour.rs::faceset_is_split_per_triangle_palette_group`
  proves a 12-triangle cube coloured 6 red + 6 green emits two correctly-coloured
  sub-meshes. (Triangle order is safe: `orient_closed_shell_outward` only flips winding
  in place and `build_flat_shaded_mesh` preserves `CoordIndex` order.)
- Note: this *re-adds* per-triangle fidelity that the #874 mesh-pipeline unification
  dropped from wasm too — so when wasm is re-pointed it regains #858 for free.

**Phase 2c — remaining (not started)**
- Material chain (§2.4 / #407): port `build_material_style_index` /
  `resolve_material_ids` / `flatten_material_color_index` so material-only-styled
  files (IFC2x3 / ArchiCAD) color in the backend too.
- Submesh transparent/opaque preference (§2.3) as a shared batch resolver.
- Point `wasm-bindings` at the shared resolver (needs an LLVM-20 / CI build to verify;
  not buildable in the current dev container).

### Phase 3 — Consumers go thin
- `processing` + `apps/server` call `resolve_element_submesh_colors` and delete their
  own resolution. `wasm-bindings` keeps only the `StyleIndex` build + `Rgba` u8 SAB
  transport + the worker-side batch call; `api/styling.rs` styling logic is removed.
- Net: the full styling pipeline exists once.

### Phase 4 — Reconcile `merge_layers` / void drivers (§2.6)
- Factor the layer/void *driver* (parts-to-skip when parent sliceable; void
  propagation to aggregated parts) into a shared `processing`/`geometry` helper used
  by both `api/mod.rs` and `processor.rs`.

### Phase 5 — Quantization contract (§2.5)
- Express the browser's 8-bit step only via `Rgba::to_rgba8`/`from_rgba8`; document
  that browser colors round to 1/255 and the backend stays exact (parity test uses a
  1/255 tolerance for the wasm path, 0 otherwise). **Resolved (§8.3): keep 8-bit as
  browser-only transport; no `f32` SAB widening.**

### Phase 6 — 2D table + adjacent dups *(follow-up issue)*
- Annotate `IFC_TYPE_FILL_COLORS` as an intentional 2D convention; optionally generate
  it from a shared export.
- Open a separate issue for the §3.3 adjacencies (style-assignment, metadata filter,
  opening heuristics, coordinate conversion).

---

## 6. Anti-regression system — *the answer to "not here again in 3 months"*

#407 proves a one-time fix erodes. Four layers, increasing durability:

### 6.1 Structural (can't drift)
The single source of truth (§4.1) + the one batch resolver (§4.2). Once consumers
call `resolve_element_submesh_colors`, there is **no second place** for a color
decision. Primary defense; everything below is backstop.

### 6.2 Golden parity test (catches logic drift)
A Rust integration test (`processing/tests/styling_parity.rs`, next to the existing
`issue_843_*` symbolic parity test) that, for each fixture:
- runs the shared resolver and asserts per-geometry colors against a checked-in
  expectation, **and**
- asserts the `wasm-bindings` extraction path and the `processing` path produce the
  **same** colors (wasm within the 1/255 tolerance; `apps/server` is covered
  automatically since it uses `processing`).

Fixtures (one per failure mode, each a tiny IFC):
- `A0513`-style `IfcIndexedColourMap`, no styled item — #663.
- 12-tri per-triangle cube — #858.
- window with frame+glazing materials — #407 / §2.3.
- material-only-styled wall (IFC2x3) — §2.4.
- layered wall with an opening — §2.6.
- a model touching all contested default types — §2.2.

### 6.3 "No second table" CI guard (catches new copies)
A test (or `scripts/` lint in CI) that scans Rust sources and **fails** if an
IFC-type→color table appears outside `processing::style` — grep for a
`get_default_color`-style signature or an `IfcType::Ifc… => [` color-literal pattern,
allowing only the canonical module and the `PARITY-ALLOW`-marked 2D table. This is the
tripwire that would have caught copies #3 and #4 the day they were added.

### 6.4 Process / docs (catches intent)
- **`AGENTS.md` rule** (new "Styling" bullet): *"Default colors and style resolution
  have exactly one home (`processing::style`), mirroring `processing::symbolic`. Never
  add a per-consumer color table or `extract_color_*`. A new IFC-type default = edit
  the one table **and** extend the parity fixture. The 2D drafting palette is the only
  sanctioned exception and must carry the `PARITY-ALLOW` marker."*
- This document as the linked rationale (ADR-style).
- PR-review checklist item: "touches color? → one table, parity fixture updated."

---

## 7. Test & verification strategy
- The §6.2 golden harness is the backbone; extend it before fixing each gap.
- Reuse the CSG fidelity patterns in `docs/research/csg-clipping-fidelity.md`.
- Manual: load each fixture in the web viewer **and** via `ifc-lite` CLI export and
  confirm matching colors (the verify/run skills can drive this).
- Definition of done (acceptance):
  1. `A0513.ifc` renders authored colors in browser **and** backend/server.
  2. The four contested default types are identical across all live consumers.
  3. Only one Rust color table exists; the CI guard is green.
  4. The parity test fails if any consumer's color resolution diverges.

---

## 8. Decisions — **resolved**

1. **Canonical default colors (§2.2): the _union_.** Each contested type keeps the
   value from whichever table defines it:
   - `IfcCurtainWall` → `[0.5,0.7,0.9,0.5]` (glass blue, from wasm)
   - `IfcStairFlight` → `[0.75,0.75,0.75,1]` (grouped with `IfcStair`, from processing)
   - `IfcBuildingElementProxy` → `[0.6,0.6,0.6,1]` (from processing)
   - `IfcFurnishingElement` → `[0.7,0.55,0.4,1]` (light wood, from **wasm** — the
     value browser users see today; processing's darker `[0.5,0.35,0.2,1]` is dropped)
   All other entries already match. This is the table `processing::style::default_color_for_type`
   ships in Phase 0/1.
2. **Backend indexed-colour fidelity (§2.1): full per-triangle split.** The backend
   matches the browser (#867) — an `IfcTriangulatedFaceSet` is split into one submesh
   per palette group, so multi-color facesets (#858) render correctly in every
   consumer. This is in scope for Phase 2 (not dominant-color-only).
3. **Quantization (§2.5/§5): 8-bit is browser-transport-only, documented.** The wasm
   path keeps `u8` RGBA across the SAB worker boundary (via `Rgba::to_rgba8`/`from_rgba8`);
   the backend stays `f32` exact. The parity test allows a 1/255 tolerance for the
   wasm path and requires exact equality elsewhere. No `f32` SAB widening.

(The earlier "is the desktop palette intentional?" question is moot — the app is being
discontinued and its table deleted with it.)

---

## 9. Risks, rollout, ownership
- **Behavioral change** is the point, not a side effect: Phase 1 changes backend and
  server colors for several types. Land each phase with snapshot updates and a clear
  changeset/PR note. Roll out phase-by-phase so any regression bisects to one PR.
- **Don't regress the wasm pre-scan budget**: `StyleIndex::from_content` must stay a
  single allocation-light scan; the resolvers must be `Rgba`-pure. Benchmark the
  pre-pass on a large file before/after Phase 3.
- **`processing` file-size** (`AGENTS.md §7`, ~400 lines): `processing::style` is its
  own module dir (`processing/src/style/{mod,index,resolve,indexed_colour}.rs`), never
  bolted onto the 2.2k-line `processor.rs`.
- **Desktop decommission** is a prerequisite for deleting copy #4 in Phase 1;
  sequence the app removal first (or in the same PR).
- **Changeset**: if any published `packages/*` surface changes (unlikely — Rust
  internal), add one per `AGENTS.md §3`, bump matching the biggest API change. Revert
  generated `packages/wasm/pkg/{README.md,package.json}` churn before committing.
- **Ownership**: geometry/processing core owns all phases; no desktop sign-off needed
  once the app is gone.
- **Sizing (rough)**: P0 ~1d (harness+fixtures), P1 ~0.5d, P2 ~2–3d (the real lift —
  port + per-triangle split + batch resolver), P3 ~1–2d (deletions + wasm transport),
  P4 ~1d, P5 ~0.5d, P6 follow-up. Guard rails (§6.2–6.4) live inside P0/P1, not extra.
