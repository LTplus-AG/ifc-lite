# Clash Detection — Architecture

Status: **shipped** (`@ifc-lite/clash`). This is the *what/why* of the design as built;
the source, tests, and changeset are the source of truth for the *how*.
Owner: clash core
Related: `docs/architecture/collaboration.md`.

---

## 0. Goal & non-negotiables

Build a clash-detection capability that is:

1. **WASM-web first** — the heavy engine runs in Rust → WASM, off the main thread, on the same geometry buffers the mesher already produces.
2. **One source of truth** — a single `@ifc-lite/clash` package consumed by the web viewer, the CLI, MCP, and scripts (plus any out-of-tree/3rd-party desktop build; see §9.4). No per-host forks.
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
    types.ts            # ClashElement, ClashRule, ClashSettings, Clash, ClashResult, ClashGroup
    selectors.ts        # selector grammar (lifted from desktop, with tests)
    disciplines.ts      # discipline presets + severity matrix (lifted)
    members.ts          # explicit set membership (ClashRule.membersA/membersB)
    engine.ts           # createClashEngine({ backend: 'ts' | 'auto' }); 'wasm' throws, see engine-wasm/
    engine-ts/          # pure-TS reference engine
      orchestrator.ts   # runClash: selection, exclusions, identity, dedup, sort (shared by both backends)
      broad.ts  narrow.ts  depth.ts  obb.ts  obb-detect.ts  tri-mesh.ts  kernel.ts  ts-kernel.ts
    engine-wasm/        # WasmClashEngine + WasmKernel over the ClashSession binding (subpath ./wasm)
    exclude.ts          # pair-exclusion set
    object-identity.ts  # clash ids and durable element identity
    grouping.ts         # cluster / rule / type-pair / element / storey grouping
    bcf-bridge.ts       # ClashResult+groups → @ifc-lite/bcf, mapBcfToClashes (subpath ./bcf)
    lifecycle.ts        # compareClashRuns: added / persistent / resolved
    review.ts  revision.ts  analysis.ts  duplicates.ts  duplicate-sets.ts  export/table.ts
    triage.ts           # buildTriageSystemPrompt / buildTriageUserMessage / parseTriageResponse
    contact/            # contact geometry helpers (subpath ./contact)
    math/               # vectors, AABBs, triangle intersection/distance (generated SAT kernel)
    adapters/
      step.ts           # IfcDataStore + MeshData[] → ClashElement[] (subpath ./step)
      step-exclusions.ts
      ifcx.ts           # IFCx composition + geometry → ClashElement[] (subpath ./ifcx)
    index.ts
  (tests sit next to the sources as *.test.ts, including differential.test.ts: TS vs WASM)

rust/clash/             # crate ifc_lite_clash, native port of the TS kernel
  src/
    lib.rs              # crate root
    session.rs          # ClashSession: ingest → run_rule (repeatable)
    bvh.rs  aabb.rs     # median-split AABB BVH (port of packages/spatial/src/bvh.ts)
    tri_mesh.rs         # per-element triangle BVH
    narrow.rs  depth.rs # SAT tri-tri intersection, minimum distance, depth + f32 floor
    obb.rs  obb_detect.rs  triangle.rs  vec3.rs  canonical.rs  generated/

rust/wasm-bindings/src/api/clash.rs        # #[wasm_bindgen] ClashSession + ClashRunResult
rust/wasm-bindings/src/api/clash_solid.rs  # intersection-solid binding used by the viewer
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
  name?: string;        // display name
  storey?: string;      // containing storey, when known (grouping, summary.byStorey)
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
  membersA?: readonly string[];  // explicit membership; replaces the `a` selector (members.ts)
  membersB?: readonly string[];  // explicit membership; replaces the `b` selector
  mode: ClashMode;
  tolerance?: number;   // m — touching band; defaults to the run-level tolerance
  clearance?: number;   // m — required gap (clearance mode)
  severity?: ClashSeverity;   // explicit; else inferred from the discipline matrix
  reportTouch?: boolean;      // emit `touch` results instead of suppressing them
}

interface ClashMatrix { rules: ClashRule[] }   // run many rules in one pass (Navisworks-style)

interface ClashSettings {
  tolerance?: number;              // default touching band (DEFAULT_CLASH_SETTINGS: 0.002 m)
  excludeVoidsAndHosts?: boolean;  // apply `exclusions`; default true
  exclusions?: ExclusionSet;       // pair-exclusion set from an adapter (§5)
  maxCandidatePairs?: number;      // TS narrow-phase checks across the whole run;
                                   // dropped pairs are reported in result.truncated
  signal?: AbortSignal;
  onProgress?: (p: { phase: 'broad'|'narrow'; rule: string; done: number; total: number }) => void;
}

interface Clash {
  id: string;                 // stable: clashPairId(ruleId, side A, side B), sides ordered;
                              // a side is `${model} ${key}` or `@` followed by a JSON tuple
                              // `[model, key, refOrNull]`. Encode a side if its key is ambiguous
                              // within the model, or if its model or key starts with `@` or
                              // contains whitespace. Only ambiguous keys include the runtime ref.
                              // `clashPairId` encodes the outer tuple for encoded sides or a rule
                              // ID that starts with `@` or contains whitespace (object-identity.ts)
  a: ClashElementRef;         // { key, ref, model, tag, name?, keyAmbiguous? }
  b: ClashElementRef;
  rule: string;
  status: 'hard' | 'clearance' | 'touch';
  distance: number;           // signed: <0 penetration depth, >0 gap
  distanceKind?: 'mesh' | 'estimate';  // measured on the meshes, or read off the AABBs
  depthFloor?: number;        // hard only: f32 noise floor of `distance` along the direction it was
                              // measured (the Hard/Touch floor); `isTouching`'s default band (#5639)
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
  truncated?: { reason: string; droppedPairs: number };
  rulesRun: ClashRule[];
  ruleCoverage?: ClashRuleCoverage[];   // per-rule selector match counts ("matched nothing" vs "no clashes")
  settings: { tolerance: number; excludeVoidsAndHosts: boolean };
}
```

**Frame convention.** The geometry pipeline emits meshes already converted to **viewer Y-up, RTC-shifted world coordinates** (`MeshDataJs::new` in `rust/wasm-bindings/src/zero_copy/mesh.rs` swaps Z-up→Y-up). The clash core works in that exact frame — so it can run zero-copy on the same buffers and its `point`/`bounds` line up with selection, coloring, and camera framing. The BCF bridge (§6) performs the documented Y-up → IFC Z-up flip (`x, -z, y`) that `packages/bcf/src/viewpoint.ts` already implements for cameras.

**Federation.** For cross-model clash every element must be in one common world frame. The step adapter lifts each mesh from its element-local frame into world positions and takes an optional caller-supplied `worldTransform` (RTC + building rotation) per model. The engine itself does not check frames: callers must align models before they call it.

---

## 4. The engine

### 4.1 Broad phase

Algorithm: **one BVH over set A, queried per element** (`candidatePairs` in `engine-ts/broad.ts`).

- Self-clash (rule with neither `b` nor `membersB`): build one BVH over the selection and query it with each element's inflated AABB, keeping each pair once (`i < j`).
- Group pair (A vs B, the common discipline-vs-discipline case; a rule is two-sided when it has a `b` selector or a `membersB` set, and an empty B side yields no candidates): build a BVH over A and query it with each B element's inflated AABB. This enumerates **only cross-group candidate pairs**, never A-A or B-B, and replaces the prototype's `groupA × groupB` double loop.
- Query AABBs are **inflated by a margin** that covers the tolerance and clearance, so clearance candidates are never missed.
- Pairs of sub-meshes of one object are skipped; entity identity is deduplicated after the narrow phase, keeping the more severe verdict.

The TS reference uses `@ifc-lite/spatial`'s `BVH` (`build` + `queryAABB`); `rust/clash/src/bvh.rs` is a faithful port of that median-split BVH, so both kernels see the same candidates.

### 4.2 Narrow phase

- **Hard clash:** exact triangle-triangle intersection by the Separating Axis Theorem (2 face normals + 9 edge-edge axes, one generated kernel shared by TS and Rust), run at **full resolution** — *no* striding, *no* `maxChecks`. Per candidate element-pair, the triangles are themselves broad-phased with a small per-element triangle BVH so the work stays proportional to actual overlap, not `trisA × trisB`.
- **Penetration depth:** exact box-box minimum translation distance when both meshes are rectangular boxes (`obb.ts`, `distanceKind: 'mesh'`); otherwise the smallest AABB overlap dimension, labelled `distanceKind: 'estimate'`. Through-penetrations report the AABB estimate capped by the box depth. `depthFloor` records the f32 noise floor that separates hard from touch.
- **Clearance:** exact triangle-triangle **minimum distance** (segment/triangle closest-point), BVH-pruned with a running-minimum bound. Replaces vertex sampling entirely.
- **Touch band:** `|distance| < tolerance` is classified `touch` and suppressed by default (walls resting on slabs are expected, not clashes) — surfaced only if a rule opts in.
- **Contact point & region:** mean of the crossing triangle pairs' contact points (hard; the overlap centre when there are none) or the closest-point midpoint (clearance), plus a tight `bounds` of the contact region for camera framing and BCF viewpoints.

### 4.3 Determinism & control

- Pure function of (elements, rules, settings). No `Math.random` in the core, and no clock in any verdict. The TS kernel reads `performance.now()` (falling back to `Date.now()`) only to pace its cooperative yields.
- Stable ordering: clashes are sorted before return, so re-runs and TS-vs-WASM agree.
- `AbortSignal` + `onProgress` for large runs. The TS backend checks the signal every 256 candidate pairs and yields about every 50 ms; the WASM backend runs a whole rule in one Rust call, so an abort takes effect between rules.
- All caps are explicit and reported in `result.truncated` — no silent truncation (project rule). `maxCandidatePairs` caps TS narrow-phase checks across all rules. The broad phase still builds each rule's candidate list. The result reports dropped checks in `result.truncated`. The WASM backend does not apply this budget.

---

## 5. Smart exclusions (a correctness multiplier the prototype lacks)

A huge fraction of naïve clash "hits" are expected adjacencies. The adapter precomputes pair-exclusions from IFC relationships (cheap, via cached `EntityNode` getters — **never** `extractEntityAttributesOnDemand` in a loop, per `AGENTS.md`):

- **Element vs its own opening/void** — `IfcRelVoidsElement` (`EntityNode.voids()`); the geometry crate already models this in `rust/geometry/src/void_index.rs`.
- **Host vs hosted filler** — door/window in its wall via `IfcRelFillsElement` (`EntityNode.filledBy()`).
- **Same assembly** — members of one `IfcRelAggregates` parent (`EntityNode.decomposes()`).
- **Self** — same `key`.

The core takes an opaque exclusion predicate / set and skips those pairs in the broad phase. Default `excludeVoidsAndHosts: true`.

---

## 6. Sensible BCF export (the headline requirement)

**Problem:** 1,000 clashes must not become 1,000 BCF topics. The `@ifc-lite/bcf` package already shows the right pattern in `createBCFFromIDSReport` (grouping strategies + `maxTopics` safety valve + `buildMultiEntityViewpoint`). We mirror it for clash.

### 6.1 Grouping (`grouping.ts`)

```ts
function groupClashes(result: ClashResult, opts: {
  by: 'cluster' | 'rule' | 'typePair' | 'element' | 'storey';
  epsilon?: number;     // cluster radius (m), default 1.5
}): ClashGroup[]
```

- **`cluster` (smart default):** DBSCAN-style spatial clustering on clash `point`s within `epsilon`, **constrained to the same rule + discipline-pair (+ storey when known)**. 40 pipe-vs-beam hits in one shaft collapse into one issue: *"MEP vs Structure — Shaft B — 40 clashes."*
- `rule` / `typePair`: one group per rule or per `IfcDuct × IfcBeam` pair.
- `element`: one group per "hot" element (a beam struck by 12 pipes → one issue owned by structure).
- `storey`: group by `IfcBuildingStorey`.

Each `ClashGroup` carries `id`, `title`, `bounds`, `representativePoint`, aggregate `severity`, optional `discipline` and `storey`, and its `members`.

### 6.2 Bridge (`bcf-bridge.ts`)

```ts
async function createBCFFromClashResult(result, groups, {
  author,
  status?,                 // flat topic status, default 'Open'
  reviewStatusOf?,         // (clash) => 'open' | 'resolved' | 'accepted'; drives topic status when given
  modelNameOf?,            // model id → file name for the topic header
  projectName?,            // default 'Clash report'
  maxTopics?,              // default 1000
  maxMembersPerTopic?,     // default 50
  cameraDistanceFactor?,   // default 2.5
  snapshotProvider?: (group: ClashGroup) => Promise<Uint8Array | undefined>,
  worldOffset?,            // translate viewpoints out of the render frame
}): Promise<BCFProject>
```

Per group → **one topic + one viewpoint**, using the existing `@ifc-lite/bcf` API:

- **Topic:** `title` from the group title; `description` = severity counts, type pairs and a member list (capped, see below); `priority` mapped from severity (`critical→High`, `major→Normal`, `minor`/`info→Low`); `labels = [discipline, 'Clash']`; `topicType = 'Clash'`; header files from `modelNameOf`.
- **Deterministic topic GUID** derived from `group.id` (stable across re-runs) → re-export **updates** topics instead of duplicating them. This is what makes BCF status survive a model revision.
- **Viewpoint** (`createViewpoint`): camera framed on `group.bounds`; `selection` = member element keys (IfcGUIDs); `coloring` = set-A red / set-B orange (ARGB hex); **snapshot** from `snapshotProvider` (the viewer renders one; CLI/headless omits it). The bridge adds no clipping planes.
- **Caps with transparency:** the member list shows the first `maxMembersPerTopic` members and ends with *"...and N more"*; a machine-readable `clash-ids:` line in the description lists every member id, uncapped. Groups beyond `maxTopics` are summarised in one overflow topic. Nothing is silently dropped.
- There is no one-topic-per-clash mode; pass fine-grained groups (e.g. `by: 'element'`) instead.

### 6.3 Round-trip & lifecycle

- Re-import a `.bcfzip` (`readBCF`) and map topics back to clash ids with `mapBcfToClashes`, which reads the `clash-ids:` line and returns, per clash id, a list of `{ topicGuid, status }` (one entry per topic the id appears in; `by: 'element'` grouping puts one clash in two topics). No host (viewer, CLI, MCP) calls it yet, so status does not flow back into the clash panel automatically.
- Combined with §8 (revisions), this turns clash from a one-shot report into a tracked workflow.

---

## 7. WASM integration

### 7.1 The `ClashSession` object

A `#[wasm_bindgen]` object in `rust/wasm-bindings/src/api/clash.rs`, decoupled from the mesher's batch lifetime:

```
new ClashSession()
  .ingest(positions, posRanges, indices, idxRanges, aabbs)   // flat numeric arenas
  .runRule(groupA, groupB | null, mode, tolerance, clearance, reportTouch) -> ClashRunResult
                                 // one rule's broad + narrow phase; repeatable, no re-ingest
  .free()                        // wasm-bindgen
```

`ClashRunResult` exposes parallel arrays (`a`, `b`, `status`, `distance`, `distanceKind`,
`depthFloor`, `points`, ...). Selection, exclusions, severity and identity stay in the
TypeScript orchestrator; the binding only ingests geometry and runs one rule at a time.

- **Memory model:** the session keeps element AABBs (cheap, persistent) plus triangle buffers in a single arena, freed on `free()`. Because clash is an *explicit* analysis (user/MCP/script-triggered), this transient cost is acceptable and bounded.
- **Default ingest path:** from the `MeshData[]` that already exist in JS — `positions`/`indices` are passed as views; wasm-bindgen copies them into the arena once.
- **Zero-copy optimization (not implemented):** tap the streaming batch mesher (`geometry.worker.ts` `'batch'` path) to ingest element geometry *as it is produced*, before transfer — no second decode. Marked optimization, not baseline, to avoid coupling lifetimes early.

### 7.2 Threading

The shipped wasm bundle is single-threaded (rayon runs serially under `web_spin_lock`). The viewer is served with COOP `same-origin` + COEP `credentialless` (`vercel.json`, `apps/viewer/vite.config.ts`), but Safari is not cross-origin isolated under `credentialless`, and the threaded bundle (see [threaded-WASM CSG](csg-threading-design.md)) is not loaded by any consumer. The planned worker-pool sharding (one `ClashSession` per worker) is **not implemented**. Today every host — the viewer (`lib/clash/clash-native-detection.ts`), the CLI and MCP — calls `createClashEngine({ backend: 'ts' })` and runs the TS engine in process. The Rust kernel is opt-in through `WasmClashEngine` from `@ifc-lite/clash/wasm` (async init, kept off the core import graph); `createClashEngine({ backend: 'wasm' })` throws and points there.

### 7.3 Differential testing

The TS reference engine is the **oracle**. `packages/clash/src/differential.test.ts` (normal `vitest`) runs both kernels through the same orchestrator and asserts identical clash sets (same ids, status and severity; distances and points within epsilon). Because the orchestrator is shared, it audits only the kernel; orchestration has its own tests. Property tests cover primitive pairs (box-box overlap/separation/touch) with analytic answers.

---

## 8. Clash lifecycle across revisions (ties into the existing diff engine)

`compareClashRuns(previous, next)` (`lifecycle.ts`) compares two clash runs (or a run before/after a model revision) the same way `diffModels` (`@ifc-lite/diff`) compares models by `globalId`. It matches by `clashReviewKey` (rule id + both elements' durable keys, order-independent), not by `clash.id`, because `clash.id` also folds in the per-load model id:

- **added** — key absent in the prior run
- **persistent** — key in both
- **resolved** — key in prior, gone now

BCF status persists via the deterministic topic GUID. This is the Navisworks "clash status carries across versions" behaviour, built on machinery the repo already has.

---

## 9. Consumer coupling

### 9.1 Web viewer (`apps/viewer`)
- New `clashSlice.ts` + `ClashPanel.tsx`, modelled on `IDSPanel`/`BCFPanel`.
- Highlight via existing actions: `addEntitiesToSelection`, the shared `isolatedEntities` / `ghostExceptEntities` channels under a `clashVisibilityOwned` record (isolate / X-ray), renderer `setColorOverrides` (A=red, B=orange), `cameraCallbacks.frameSelection`, and `SectionPlane` for slicing to a clash. "Export to BCF" uses §6 with a viewer snapshot provider. The run logic lives in `apps/viewer/src/lib/clash/` (`clash-native-runtime.ts`, `-detection`, `-focus`, `-export`) behind `hooks/useClash.ts`; saved reports live in `savedClashReportsSlice.ts`.

### 9.2 MCP (`packages/mcp`)
- `clash_check` (`packages/mcp/src/tools/clash.ts`): build elements with `elementsFromStep`, run the TS engine in Node, return structured + grouped results honoring `scope:'read'`, `progress`, `signal`.
- `clash_matrix` (run discipline presets). The `clash_review` prompt (`prompts/templates.ts`) already orchestrates this. (A separate `clash_report` grouped-summary tool is not implemented; grouped summaries ride the `clash_check`/`clash_matrix` results.)

### 9.3 Scripts / CLI / sandbox
- `bim.clash.run`, `bim.clash.matrix`, `bim.clash.group`, `bim.clash.presets` and `bim.clash.disciplineRules` in the sandbox bridge (`packages/sandbox/src/bridge-clash.ts`, wired in `bridge-schema.ts`), returning serializable results.
- Headless `ifc-lite clash` CLI command (TS engine in Node) with `--a`, `--b`, `--mode`, `--tolerance`, `--clearance`, `--matrix`, `--json`, `--csv`, `--bcf out.bcfzip`, `--bcf-status`, `--max-topics` and `--group cluster|rule|typePair|element`. See the [CLI guide](../guide/cli.md).

### 9.4 Desktop migration (not pursued)
- The desktop app could replace `src/desktop/analysis/clash-engine.ts` with `@ifc-lite/clash` (keeping its panel + AI triage via the package's pure `triage.ts`). Out of scope for this work; noted as a possible future direction in the separate `ifc-lite-desktop` repo.

---

## 10. Delivery (as shipped)

Built in independently-shippable phases (P0–P6, all landed on `feat/clash-detection`).
P7 (desktop migration) was not pursued — see §9.4.

| Phase | Deliverable | Why it's valuable alone |
|---|---|---|
| **0. Foundations** | `packages/clash`: types, selectors, disciplines, **TS reference engine** (BVH broad + exact tri-tri + exact distance), step adapter, exclusions, determinism, tests | Already strictly more correct than the desktop engine (no decimation, real distance, exclusions, true contact point) |
| **1. Panel** | `clashSlice`, `ClashPanel`, discipline-matrix UI, color/isolate/frame/section wiring (no dedicated clash worker shipped) | Interactive clash in the web viewer |
| **2. Sensible BCF** | `grouping.ts` + `bcf-bridge.ts`, deterministic topic GUIDs, caps-with-transparency, viewpoint framing/coloring/clipping/snapshot, round-trip import | The headline requirement: grouped, deduplicated, lifecycle-ready BCF |
| **3. Rust/WASM core** | `rust/clash` + `ClashSession` binding, `@ifc-lite/clash/wasm`, differential tests. `backend:'auto'` still resolves to TS and worker-pool sharding was not built | Native-speed kernel, opt-in |
| **4. MCP + scripting + CLI** | implement `clash_check`, add `clash_matrix`, `bim.clash.*`, `ifc-lite clash` | Headless + agentic clash; couples to automation |
| **5. Lifecycle** | revision diffing of clash sets, BCF status persistence | Clash becomes a tracked workflow, not a snapshot |
| **6. IFC5/USD** | `adapters/ifcx.ts` (prim path = key, component type = tag, geom from ifcx extractor) | Proves and delivers the future-alignment; core unchanged |
| **7. Desktop migration** *(not pursued)* | desktop consumes `@ifc-lite/clash`; delete private engine | Single source of truth |

---

## 11. Risks & open questions

1. **WASM narrow-phase memory** — keeping triangles resident. *Mitigation:* explicit `ClashSession` with `free()`; persistent index holds AABBs only, triangles streamed per candidate when memory-constrained.
2. **No threads in the shipped bundle** — worker-pool sharding is not built; the opt-in `wasm-bindgen-rayon` threaded bundle is not wired into clash.
3. **Federation frame alignment** — cross-model clash must share one world frame. *Mitigation:* the step adapter takes a per-model `worldTransform`; the engine does not detect a mismatch, so callers must align models first.
4. **Tessellation & clearance** — distance is to facets, slightly conservative on curved surfaces. *Acceptable; documented.*
5. **TS vs WASM float drift** — *Mitigation:* epsilon bands in differential tests; deterministic ordering.
6. **Instancing** — confirmed the streaming mesher emits de-instanced, world-baked `MeshData`, so `transform` defaults to identity; the `transform` field is reserved for a future instanced path.
7. **AI triage placement** — kept as pure prompt build/parse in `triage.ts`; hosts (desktop, web chat, CLI `ask`, MCP `clash_review`) own the LLM call.
