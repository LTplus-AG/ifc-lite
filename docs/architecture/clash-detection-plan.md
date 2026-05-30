# Clash Detection — Architecture & Implementation Plan

Status: **proposed**
Owner: clash core
Related: `docs/architecture/collab-plan.md`, `docs/architecture/streaming-load-design.md`, the existing `clash_check` MCP stub (`packages/mcp/src/tools/geometry.ts:229`), and the prototype in `ifc-lite-desktop` (`src/desktop/analysis/`).

---

## 0. Goal & non-negotiables

Build a clash-detection capability that is:

1. **WASM-web first** — the heavy engine runs in Rust → WASM, off the main thread, on the same geometry buffers the mesher already produces.
2. **One source of truth** — a single `@ifc-lite/clash` package consumed by the web viewer, the desktop app, the CLI, MCP, and scripts. No per-host forks.
3. **Future-aligned for IFC5/USD** — the engine operates on a representation-agnostic element model; STEP/IFC4 and IFCx/USD are just *adapters* that feed it.
4. **Correct** — no silent decimation, real triangle-triangle intersection and distance, true contact points, smart exclusions (voids/hosts/assemblies). This is the bar the desktop prototype does not meet.
5. **BCF-sensible** — clash results flow into BCF as a *manageable* set of grouped, deduplicated, lifecycle-aware topics — never thousands of one-clash topics.

### What we are deliberately replacing from the desktop prototype

The `ifc-lite-desktop` engine (`src/desktop/analysis/clash-engine.ts`) is a good *product* prototype but its detector has four disqualifying traits for a shared core:

- **O(n²) broad phase** that ignores the `BVH` already in `@ifc-lite/spatial` (`packages/spatial/src/bvh.ts`).
- **Silent narrow-phase decimation** — `triangleIntersectionTest` caps at `maxChecks = 50_000` and strides over triangles, producing *false negatives* with no signal.
- **Vertex-sampled clearance** (`meshMinDistance`, 200 samples/side) — unreliable face-to-face gaps.
- **STEP-locked identity** — `entityIndex.byType` + `expressId` + `EntityNode.globalId` is fused into the detector, so it cannot serve IFC5.

What we **keep** from the prototype: the selector grammar (`IfcPipe*|IfcValve*`, `!IfcWall`), the discipline/severity presets (`clash-disciplines.ts`), the AI-triage prompt shape (`clash-triage.ts`), and the panel UX.

---

## 1. Layered architecture

```
                         ┌──────────────────────────────────────────┐
   Source adapters       │  step-adapter        ifcx-adapter (IFC5)  │
   (version-specific)    │  IfcDataStore+Mesh   USD composition+geom │
                         └───────────────┬──────────────────────────┘
                                         │ ClashElement[]  (id, tag, bounds, tris, xform)
                         ┌───────────────▼──────────────────────────┐
   Clash core            │  broad phase (BVH / dual-tree / SAP)      │
   (representation-       │  narrow phase (exact tri-tri + distance) │
    agnostic, pure)      │  exclusions (void / host / assembly)     │
                         │  Rust→WASM  •  TS reference (oracle)      │
                         └───────────────┬──────────────────────────┘
                                         │ ClashResult (deterministic, serializable)
                 ┌───────────────────────┼───────────────────────────┐
   Consumers     │ grouping → BCF     viewer panel    MCP     scripts/CLI │
                 │ (sensible export)  (color/isolate)  tools   (headless)  │
                 └──────────────────────────────────────────────────────┘
```

The hard rule: **the core never imports `@ifc-lite/parser`, `@ifc-lite/query`, or anything STEP-specific.** Element enumeration and identity live in adapters. This is precisely what makes IFC5 a new adapter rather than a rewrite.

---

## 2. Package & crate layout

```
packages/clash/
  src/
    types.ts            # ClashElement, ClashRule, ClashMatrix, Clash, ClashResult, ClashGroup
    selectors.ts        # selector grammar (lifted from desktop, with tests)
    disciplines.ts      # discipline presets + severity matrix (lifted)
    engine.ts           # createClashEngine({backend:'wasm'|'ts'|'auto'})
    engine-ts/          # pure-TS reference engine (broad: spatial BVH, narrow: exact)
      broad.ts  narrow.ts  distance.ts  exclude.ts
    engine-wasm/        # thin bindings to rust/clash via @ifc-lite/wasm
    grouping.ts         # cluster / rule / type-pair / element / storey grouping
    bcf-bridge.ts       # ClashResult+groups → @ifc-lite/bcf (sensible)
    triage.ts           # buildTriagePrompt / parseTriage (pure; host calls the LLM)
    adapters/
      step.ts           # IfcDataStore + MeshData[] → ClashElement[]
      ifcx.ts           # IFCx composition + geometry → ClashElement[]   (Phase 6)
    index.ts
  worker/clash.worker.ts
  test/                 # unit + differential (TS vs WASM) + golden fixtures

rust/clash/             # new crate, sibling of rust/geometry
  src/
    lib.rs              # ClashSession: ingest → build → run_rules → results → free
    element.rs          # ElementId, Aabb, triangle ranges into a shared arena
    broad.rs            # BVH build + dual-tree overlap traversal; SAP fallback
    narrow.rs           # exact tri-tri intersection (Guigue–Devillers) + penetration
    distance.rs         # exact tri-tri minimum distance (clearance), BVH-pruned
    exclude.rs          # pair-exclusion sets (void/host/assembly)
    report.rs           # Clash record + flat-array/packed serialization to JS

rust/wasm-bindings/src/api/clash.rs   # #[wasm_bindgen] ClashSession surface
```

Conventions (from `AGENTS.md`): MPL-2.0 header on every source file; `pnpm changeset` for the new published package; **tests are mandatory for the new package**; modules ≤ ~400 lines; strict IFC nomenclature in any user-facing output; resolve IDs through `FederationRegistry` (`toGlobalId`/`fromGlobalId`/`getModelForGlobalId`), never ad-hoc math.

---

## 3. The core data model (representation-agnostic)

```ts
// Identity is split: a DURABLE key for persistence/BCF/lifecycle, and a
// RUNTIME ref for selection/coloring in the renderer.
interface ClashElement {
  key: string;          // durable: IfcGUID (STEP) or USD prim path (IFC5). BCF + dedup + lifecycle.
  ref: number;          // runtime: federated globalId / expressId. Selection + coloring.
  model: string;        // model/file id (federation)
  tag: string;          // classification: 'IfcWall', or USD component type. Selectors + severity.
  bounds: AABB;         // world-frame AABB
  positions: Float32Array; // world frame, Y-up (the geometry-pipeline frame), de-instanced
  indices: Uint32Array;
  transform?: Mat4;     // identity by default; present only if positions are kept local (instancing)
}

type ClashMode = 'hard' | 'clearance';
// hard      = solids interpenetrate (penetration depth > tolerance)
// clearance = solids are separate but within `clearance` (with a `touch` band carved out)

interface ClashRule {
  id: string;
  name: string;
  a: string;            // selector
  b?: string;           // selector; omitted ⇒ self-clash within A
  mode: ClashMode;
  tolerance: number;    // m — touching band; |d| < tolerance is "touch", suppressed by default
  clearance?: number;   // m — required gap (clearance mode)
  severity?: ClashSeverity;   // explicit; else inferred from the discipline matrix
  exclude?: ClashExclusions;  // see §5
}

interface ClashMatrix { rules: ClashRule[] }   // run many rules in one pass (Navisworks-style)

interface ClashSettings {
  tolerance: number;          // default touching band
  excludeVoidsAndHosts: boolean;   // default true
  maxCandidatePairs?: number;      // safety cap — NEVER silent; reported in result.truncated
  workers?: number;                // narrow-phase shard count (worker pool)
  signal?: AbortSignal;
  onProgress?: (p: { phase: 'broad'|'narrow'; done: number; total: number }) => void;
}

interface Clash {
  id: string;                 // stable: hash(min(keyA,keyB), max(keyA,keyB), ruleId)
  a: ClashElementRef;         // { key, ref, model, tag, name }
  b: ClashElementRef;
  rule: string;
  status: 'hard' | 'clearance' | 'touch';
  distance: number;           // signed: <0 penetration depth, >0 gap
  point: [number, number, number];  // TRUE contact/closest point (world Y-up)
  bounds: AABB;               // overlap (hard) or closest-region (clearance) bounds — for framing
  severity: ClashSeverity;
}

interface ClashResult {
  clashes: Clash[];
  summary: {
    total: number;
    byRule: Record<string, number>;
    byTypePair: Record<string, number>;
    bySeverity: Record<ClashSeverity, number>;
    byStorey?: Record<string, number>;
  };
  truncated?: { reason: string; droppedPairs: number; droppedClashes: number };
  rulesRun: ClashRule[];
  settings: ClashSettings;
}
```

**Frame convention.** The geometry pipeline emits meshes already converted to **viewer Y-up, RTC-shifted world coordinates** (`rust/wasm-bindings/src/zero_copy.rs` swaps Z-up→Y-up). The clash core works in that exact frame — so it can run zero-copy on the same buffers and its `point`/`bounds` line up with selection, coloring, and camera framing. The BCF bridge (§6) performs the documented Y-up → IFC Z-up flip (`x, -z, y`) that `packages/bcf/src/viewpoint.ts` already implements for cameras.

**Federation.** For cross-model clash every element must be in one common world frame. The step adapter applies each model's alignment (RTC offset + `buildingRotation` from `CoordinateInfo`, via `geometry-coordinate.ts`) before producing `ClashElement.positions`/`bounds`. The engine asserts a single frame and refuses to mix unaligned models (a guard the desktop prototype lacks).

---

## 4. The engine

### 4.1 Broad phase

Primary algorithm: **dual-tree BVH overlap traversal**.

- Self-clash (rule with no `b`): build one BVH over the selection, descend the tree against itself, emit overlapping leaf pairs once.
- Group pair (A vs B, the common discipline-vs-discipline case): build a BVH per group and traverse them together — this enumerates **only cross-group candidate pairs**, never A-A or B-B. This is the key scaling win over the prototype's `groupA × groupB` double loop.
- AABBs are **inflated by `max(tolerance, clearance)`** at this phase so clearance candidates are never missed.
- Sweep-and-prune is the fallback / cross-check for the self-clash case.

The TS reference uses `@ifc-lite/spatial`'s `BVH` (already exports `build` + `queryAABB`); the Rust core has its own cache-friendly BVH over a flat AABB array.

### 4.2 Narrow phase

- **Hard clash:** exact triangle-triangle intersection (Guigue–Devillers / Möller), run at **full resolution** — *no* striding, *no* `maxChecks`. Per candidate element-pair, the triangles are themselves broad-phased with a small per-element triangle BVH so the work stays proportional to actual overlap, not `trisA × trisB`.
- **Penetration depth:** estimated from the intersection segments' extent along the contact normal; feeds severity ("12 cm overlap" ≫ "2 mm touch").
- **Clearance:** exact triangle-triangle **minimum distance** (segment/triangle closest-point), BVH-pruned with a running-minimum bound. Replaces vertex sampling entirely.
- **Touch band:** `|distance| < tolerance` is classified `touch` and suppressed by default (walls resting on slabs are expected, not clashes) — surfaced only if a rule opts in.
- **Contact point & region:** centroid of intersection segments (hard) or the closest-point midpoint (clearance), plus a tight `bounds` of the contact region for camera framing and BCF viewpoints.

### 4.3 Determinism & control

- Pure function of (elements, rules, settings). No `Date.now`/`Math.random` in the core (matches the constraint already enforced in the geometry crate).
- Stable ordering: candidate pairs and clashes sorted by `(keyA, keyB, ruleId)` before return, so re-runs and TS-vs-WASM agree.
- `AbortSignal` + `onProgress` for large runs (UI, MCP, CLI all consume these).
- All caps are explicit and reported in `result.truncated` — no silent truncation (project rule).

---

## 5. Smart exclusions (a correctness multiplier the prototype lacks)

A huge fraction of naïve clash "hits" are expected adjacencies. The adapter precomputes pair-exclusions from IFC relationships (cheap, via cached `EntityNode` getters — **never** `extractEntityAttributesOnDemand` in a loop, per `AGENTS.md`):

- **Element vs its own opening/void** — `IfcRelVoidsElement` (`EntityNode.voids()`); the Rust crate already models this in `void_index.rs` / `void_analysis.rs`.
- **Host vs hosted filler** — door/window in its wall via `IfcRelFillsElement` (`EntityNode.filledBy()`).
- **Same assembly** — members of one `IfcRelAggregates` parent (`EntityNode.decomposes()`).
- **Self** — same `key`.

The core takes an opaque exclusion predicate / set and skips those pairs in the broad phase. Default `excludeVoidsAndHosts: true`.

---

## 6. Sensible BCF export (the headline requirement)

**Problem:** 1,000 clashes must not become 1,000 BCF topics. The `@ifc-lite/bcf` package already shows the right pattern in `createBCFFromIDSReport` (grouping strategies + `maxTopics` safety valve + `createMultiEntityViewpoint`). We mirror it for clash.

### 6.1 Grouping (`grouping.ts`)

```ts
function groupClashes(result: ClashResult, opts: {
  by: 'cluster' | 'rule' | 'typePair' | 'element' | 'storey';
  epsilon?: number;     // cluster radius (m), default e.g. 1.5
  maxGroups?: number;
  maxPerGroup?: number;
}): ClashGroup[]
```

- **`cluster` (smart default):** DBSCAN-style spatial clustering on clash `point`s within `epsilon`, **constrained to the same rule + discipline-pair (+ storey when known)**. 40 pipe-vs-beam hits in one shaft collapse into one issue: *"MEP vs Structure — Shaft B — 40 clashes."*
- `rule` / `typePair`: one group per rule or per `IfcDuct × IfcBeam` pair.
- `element`: one group per "hot" element (a beam struck by 12 pipes → one issue owned by structure).
- `storey`: group by `IfcBuildingStorey`.

Each `ClashGroup` carries `bounds`, a representative point, aggregate `severity`, discipline, and its member clashes.

### 6.2 Bridge (`bcf-bridge.ts`)

```ts
function createBCFFromClashResult(result, groups, {
  author, grouping, maxTopics = 1000,
  status = 'Open', priorityFromSeverity = true,
  snapshotProvider?: (group: ClashGroup) => Promise<Uint8Array | undefined>,
}): BCFProject
```

Per group → **one topic + one viewpoint**, using the existing `@ifc-lite/bcf` API:

- **Topic:** `title` from the group label; `description` = severity counts + member table (capped, see below); `priority` mapped from severity (`critical→High`…); `labels = [discipline, 'Clash']`; `topicType = 'Clash'`.
- **Deterministic topic GUID** derived from `group.id` (stable across re-runs) → re-export **updates** topics instead of duplicating them. This is what makes BCF status survive a model revision.
- **Viewpoint** (`createViewpoint`): camera framed on `group.bounds`; `selection` = member element `ifcGuid`s; `coloring` = set-A red / set-B orange (ARGB hex); optional **clipping plane / section box** around `group.bounds`; **snapshot** from `snapshotProvider` (the viewer renders one offscreen; CLI/headless omits it).
- **Caps with transparency:** if a group has 500 members, the topic states *"500 clashes (top 20 by penetration depth shown)"* and the rest go to an attached CSV comment — never silently dropped.
- **Detailed mode:** for small result sets (`< N`), allow one-topic-per-clash via `grouping: 'per-clash'` with a guard.

### 6.3 Round-trip & lifecycle

- Re-import a `.bcfzip` (`readBCF`) and map topics back to clash groups via the deterministic GUID → assignment/status (`Open`/`Closed`/`Assigned`) flows back into the clash panel.
- Combined with §8 (revisions), this turns clash from a one-shot report into a tracked workflow.

---

## 7. WASM integration

### 7.1 The `ClashSession` object

A `#[wasm_bindgen]` object in `rust/wasm-bindings/src/api/clash.rs`, decoupled from the mesher's batch lifetime:

```
ClashSession::new()
  .ingest(ids, tags_interned, aabbs, positions_arena, index_ranges)  // flat arrays, mirrors the geometry pipeline's pattern
  .build()                       // broad-phase index
  .run_rules(rules_json) -> packed results   // repeatable; no re-ingest
  .free()
```

- **Memory model:** the session keeps element AABBs (cheap, persistent) plus triangle buffers in a single arena, freed on `free()`. Because clash is an *explicit* analysis (user/MCP/script-triggered), this transient cost is acceptable and bounded.
- **Default ingest path:** from the `MeshData[]` that already exist in JS — `positions`/`indices` are passed as views; wasm-bindgen copies them into the arena once.
- **Zero-copy optimization (Phase 3+):** tap the streaming batch mesher (`geometry.worker.ts` `'batch'` path) to ingest element geometry *as it is produced*, before transfer — no second decode. Marked optimization, not baseline, to avoid coupling lifetimes early.

### 7.2 Threading

`wasm32` has no real threads here (rayon runs serially under `web_spin_lock`; the repo sets no COOP/COEP). So we **scale the narrow phase with the existing N-worker pattern** (`geometry-parallel.ts`): shard candidate pairs across workers, each with its own WASM `ClashSession` instance over a shared read-only arena. This reuses proven infrastructure and needs no cross-origin isolation. If the app later enables COOP/COEP, `wasm-bindgen-rayon` becomes a drop-in upgrade for in-instance parallelism.

### 7.3 Differential testing

The TS reference engine is the **oracle**. CI (normal `vitest`, not a new heavy job — consistent with the "prefer nudges over expensive CI" principle) runs both engines on golden fixtures and asserts identical clash sets (same pairs; distances within epsilon). Property tests cover primitive pairs (box-box overlap/separation/touch) with analytic answers.

---

## 8. Clash lifecycle across revisions (ties into the existing diff engine)

Stable `clash.id = hash(min(keyA,keyB), max(keyA,keyB), ruleId)` lets us compare two clash runs (or a run before/after a model revision) the same way `computeDiff` compares models by `globalId`:

- **new** — id absent in the prior run
- **persistent** — id in both
- **resolved** — id in prior, gone now

BCF status persists via the deterministic topic GUID. This is the Navisworks "clash status carries across versions" behaviour, built on machinery the repo already has.

---

## 9. Consumer coupling

### 9.1 Web viewer (`apps/viewer`)
- New `clashSlice.ts` + `ClashPanel.tsx`, modelled on `IDSPanel`/`BCFPanel`.
- Highlight via existing actions: `addEntitiesToSelection`, `hideEntitiesInModel`/`showEntitiesInModel` (isolate), renderer `setColorOverrides` (A=red, B=orange), `cameraCallbacks.frameSelection`, and `SectionPlane` for slicing to a clash. "Export to BCF" uses §6 with a viewer snapshot provider; "Open BCF" round-trips status back.

### 9.2 MCP (`packages/mcp`)
- Implement the existing `clash_check` stub (`tools/geometry.ts:229`): resolve A/B GlobalId selections via `entityIndex.byType` + `EntityNode`, run the engine (WASM-in-Node), return structured + grouped results honoring `scope:'read'`, `progress`, `signal`.
- Add `clash_matrix` (run discipline presets) and `clash_report` (grouped summary). The `clash_review` prompt (`prompts/templates.ts:133`) already orchestrates this.

### 9.3 Scripts / CLI / sandbox
- `bim.clash.run(selA, selB, opts)` / `bim.clash.matrix(presets)` in the sandbox bridge (`packages/sandbox/src/bridge-schema.ts`), returning serializable `ClashResult`.
- New headless `ifc-lite clash` CLI command (WASM runs in Node) with `--json`, `--matrix`, `--bcf out.bcfzip`, `--group cluster`. Fits the existing `eval`/`run` power-tool model.

### 9.4 Desktop migration
- Replace `src/desktop/analysis/clash-engine.ts` with `@ifc-lite/clash`; keep the panel, BCF export, and AI triage (now `triage.ts` in the package — pure prompt build/parse; the desktop keeps its LLM call). Delete the private engine so the two never diverge.

---

## 10. Phased delivery

Each phase is independently shippable and leaves the product better.

| Phase | Deliverable | Why it's valuable alone |
|---|---|---|
| **0. Foundations** | `packages/clash`: types, selectors, disciplines, **TS reference engine** (BVH broad + exact tri-tri + exact distance), step adapter, exclusions, determinism, tests | Already strictly more correct than the desktop engine (no decimation, real distance, exclusions, true contact point) |
| **1. Worker + panel** | `clash.worker.ts`, `clashSlice`, `ClashPanel`, discipline-matrix UI, color/isolate/frame/section wiring | Interactive clash in the web viewer, off main thread |
| **2. Sensible BCF** | `grouping.ts` + `bcf-bridge.ts`, deterministic topic GUIDs, caps-with-transparency, viewpoint framing/coloring/clipping/snapshot, round-trip import | The headline requirement: grouped, deduplicated, lifecycle-ready BCF |
| **3. Rust/WASM core** | `rust/clash` + `ClashSession` binding, `backend:'auto'`, differential tests, worker-pool sharding | Production performance; 1M-triangle models without freezing |
| **4. MCP + scripting + CLI** | implement `clash_check`, add `clash_matrix`/`clash_report`, `bim.clash.*`, `ifc-lite clash` | Headless + agentic clash; couples to automation |
| **5. Lifecycle** | revision diffing of clash sets, BCF status persistence | Clash becomes a tracked workflow, not a snapshot |
| **6. IFC5/USD** | `adapters/ifcx.ts` (prim path = key, component type = tag, geom from ifcx extractor) | Proves and delivers the future-alignment; core unchanged |
| **7. Desktop migration** | desktop consumes `@ifc-lite/clash`; delete private engine | Single source of truth |

---

## 11. Risks & open questions

1. **WASM narrow-phase memory** — keeping triangles resident. *Mitigation:* explicit `ClashSession` with `free()`; persistent index holds AABBs only, triangles streamed per candidate when memory-constrained.
2. **No threads / no cross-origin isolation today** — *Mitigation:* worker-pool sharding now; `wasm-bindgen-rayon` later if COOP/COEP is adopted.
3. **Federation frame alignment** — cross-model clash must share one world frame. *Mitigation:* adapter applies RTC + `buildingRotation` via `geometry-coordinate.ts`; engine guards mismatches.
4. **Tessellation & clearance** — distance is to facets, slightly conservative on curved surfaces. *Acceptable; documented.*
5. **TS vs WASM float drift** — *Mitigation:* epsilon bands in differential tests; deterministic ordering.
6. **Instancing** — confirmed the streaming mesher emits de-instanced, world-baked `MeshData`, so `transform` defaults to identity; the `transform` field is reserved for a future instanced path.
7. **AI triage placement** — kept as pure prompt build/parse in `triage.ts`; hosts (desktop, web chat, CLI `ask`, MCP `clash_review`) own the LLM call.

---

## 12. First concrete step (Phase 0 scaffold)

1. `pnpm` workspace package `packages/clash` with MPL headers + changeset.
2. Lift `selectors.ts` and `disciplines.ts` verbatim from the desktop prototype (with tests).
3. Implement `engine-ts/` (broad via `@ifc-lite/spatial` BVH; exact tri-tri intersection + distance), `adapters/step.ts`, `exclude.ts`.
4. Golden fixtures + unit tests; wire nothing into the app yet.

This yields a correct, headless, tested clash engine that the CLI and MCP can call immediately — and that becomes the oracle for the Rust core in Phase 3.
