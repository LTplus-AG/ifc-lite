# Clash Detection — Implementation Plan (codebase-grounded)

Companion to `clash-detection-plan.md` (the *what/why*). This is the *how*: exact files, signatures, integration symbols, tests, changesets, and acceptance criteria per phase, mapped onto the real repo.

All symbols referenced below were verified against the source:
- `AABB` + `BVH` — `packages/spatial/src/{aabb,bvh}.ts` (`BVH.build(MeshWithBounds[])`, `queryAABB(AABB): number[]`).
- `MeshData` — `packages/geometry/src/types.ts` (`expressId`, `ifcType?`, `positions: Float32Array`, `indices: Uint32Array`, `modelIndex?`).
- `EntityNode` — `packages/query/src/entity-node.ts` (`globalId`, `name`, `type`, `voids()`, `filledBy()`, `decomposes()`, `decomposedBy()`, `storey()`, `building()`).
- `IfcDataStore` — `packages/parser/src/columnar-parser.ts:51` (`entityIndex.byType: Map<string, number[]>`, `entities.getTypeName(id)`).
- `FederationRegistry` — `packages/renderer/src/federation-registry.ts:35` (`toGlobalId(modelId, expressId)`, `fromGlobalId`, `getModelForGlobalId`).
- BCF API — `packages/bcf/src/index.ts` (`createBCFProject`, `createBCFTopic`, `createViewpoint`, `addTopicToProject`, `addViewpointToTopic`, `writeBCF`, `readBCF`, `cameraToPerspective`).
- MCP tool pattern — `packages/mcp/src/tools/geometry.ts:229` (`clash_check` stub), `tools/types.ts` (`Tool`, `ToolRegistry`), `server.ts` (`ToolContext`).
- Sandbox bridge — `packages/sandbox/src/bridge-schema.ts` (`NAMESPACE_SCHEMAS`).

---

## Global conventions (apply to every phase)

- **MPL-2.0 header** on every new `.ts`/`.rs` file (`LICENSE_HEADER.md`).
- **Module size ≤ ~400 lines**; split eagerly (the math + engine modules are the ones at risk).
- **No `as any` / `@ts-ignore`; no bare `catch {}`** (log or rethrow).
- **Tests mandatory** for the new package and every feature; `vitest run` per package (mirror `packages/bcf`).
- **`tsconfig.json`** extends `../../tsconfig.packages.json` (nodenext; extensionful relative imports, e.g. `./types.js`).
- **Strict IFC nomenclature** in user-facing output; resolve IDs via `FederationRegistry`, never ad-hoc math.
- **Architectural boundary enforced by subpath exports** (below): the core entry must not transitively import `@ifc-lite/parser`/`@ifc-lite/query`.
- **`packages/clash` starts `"private": true`** — developed in-workspace (consumed by viewer/cli/desktop via `workspace:^`), flipped to public + changeset when stabilized (≈ end of Phase 3). This avoids premature npm publishes and changeset churn during build-out. Once public: initial `1.0.0` to match the ≥1.0 sibling bump semantics in `AGENTS.md`.
- **Generated WASM** (`packages/wasm/pkg/*`) is never hand-edited; change Rust + regenerate via `scripts/build-wasm.sh`. After a local build, `git checkout packages/wasm/pkg/{README.md,package.json}` (generated churn).

### Subpath export map (target `packages/clash/package.json`)

```jsonc
"exports": {
  ".":          { "import": "./dist/index.js",            "types": "./dist/index.d.ts" },        // core: types, engine, selectors, disciplines, grouping, triage
  "./step":     { "import": "./dist/adapters/step.js",    "types": "./dist/adapters/step.d.ts" }, // depends on parser/query/data
  "./ifcx":     { "import": "./dist/adapters/ifcx.js",    "types": "./dist/adapters/ifcx.d.ts" }, // depends on @ifc-lite/ifcx  (Phase 6)
  "./bcf":      { "import": "./dist/bcf-bridge.js",       "types": "./dist/bcf-bridge.d.ts" },    // depends on @ifc-lite/bcf   (Phase 2)
  "./worker":   { "import": "./dist/clash.worker.js",     "types": "./dist/clash.worker.d.ts" }   // Phase 1
}
```

Rationale: a consumer that imports `@ifc-lite/clash` (core) pulls only `@ifc-lite/spatial` + geometry *types*. STEP, IFCx, and BCF arrive only through their subpaths. This is the module-level guarantee behind "IFC5 is a new adapter, not a rewrite."

---

## Phase 0 — `packages/clash` foundations (TS reference engine)

**Outcome:** a correct, headless, tested clash engine — already strictly better than the desktop prototype (no decimation, exact distance, exclusions, true contact point) — usable from Node and the future oracle for the Rust core.

### Files to create

| File | Purpose | Key exports / signatures | ~LOC |
|---|---|---|---|
| `package.json` | private pkg; deps `@ifc-lite/spatial`, `@ifc-lite/geometry`; subpath deps `@ifc-lite/parser`,`@ifc-lite/query`,`@ifc-lite/data` (for `./step`); dev `vitest`,`typescript` | — | — |
| `tsconfig.json` | extends `../../tsconfig.packages.json` | — | — |
| `README.md` | package intro + usage | — | — |
| `src/index.ts` | core barrel (NO adapters) | re-exports types, `createClashEngine`, `matchesSelector`, disciplines, `groupClashes`(P2), triage | 20 |
| `src/types.ts` | all data types | `ClashElement`, `ClashElementRef`, `ClashMode`, `ClashStatus`, `ClashSeverity`, `ClashRule`, `ClashMatrix`, `ClashSettings`, `Clash`, `ClashResult`, `ClashGroup`, `ExclusionSet`; re-export `AABB` from spatial; `Vec3=[number,number,number]`, `Mat4=readonly number[]` | 160 |
| `src/selectors.ts` | lifted `matchesSelector` (desktop `clash-engine.ts:75-107`) | `matchesSelector(tag: string, selector: string): boolean` | 45 |
| `src/disciplines.ts` | lifted presets | `DISCIPLINES`, `CLASH_RULE_PRESETS`, `inferClashSeverity(a,b)` (refactored to call `matchesSelector`) | 180 |
| `src/math/vec3.ts` | vector ops | `sub,cross,dot,len,scale,add,mid` | 60 |
| `src/math/aabb.ts` | AABB helpers atop spatial | `fromPositions`, `inflate`, `signedGap`, `overlapBounds` | 90 |
| `src/math/triangle-intersect.ts` | exact tri-tri overlap | `triTriIntersect(a0,a1,a2,b0,b1,b2,eps): boolean` (SAT, 11 axes, degenerate-axis guard) | 120 |
| `src/math/triangle-distance.ts` | exact tri-tri min distance + closest pts | `triTriDistance(...): { dist, pA, pB }`, `segSegDistance`, `closestPtPointTriangle` | 220 |
| `src/exclude.ts` | pair-exclusion set | `pairKey(a,b)`, `makeExclusionSet()`, `isExcluded(set,a,b)` | 40 |
| `src/engine-ts/tri-mesh.ts` | per-element tri BVH wrapper (caches) | `class TriMesh { bvh; tri(i); count; queryTris(aabb): number[] }` (builds spatial `BVH` over per-tri AABBs) | 90 |
| `src/engine-ts/broad.ts` | candidate pairs via spatial `BVH` | `candidatePairs(a, b\|null, margin): Array<[number,number]>` | 110 |
| `src/engine-ts/narrow.ts` | classify a pair | `testPair(elA, elB, rule, settings): NarrowResult \| null` | 200 |
| `src/engine-ts/index.ts` | the TS engine | `class TsClashEngine implements ClashEngine` | 220 |
| `src/engine.ts` | factory + interface | `interface ClashEngine { run(elements, rules, settings): Promise<ClashResult> }`, `createClashEngine({backend:'ts'\|'wasm'\|'auto'}): ClashEngine` (P0: `'ts'` only) | 60 |
| `src/triage.ts` | lifted AI-triage (pure) | `buildTriageSystemPrompt()`, `buildTriageUserMessage(result)`, `parseTriageResponse(text,result)` | 140 |
| `src/adapters/step.ts` | STEP→elements + exclusions | `elementsFromStep(opts): { elements: ClashElement[]; exclusions: ExclusionSet }` | 200 |

### Engine algorithm (locked)

Broad phase (`broad.ts`): build spatial `BVH` over group A (`expressId` slot = A-array index). For a pair rule, query the BVH with each B element's `inflate(bounds, margin)` where `margin = max(tolerance, clearance ?? 0)`; emit `[aIdx, bIdx]`. For self-clash, query A against its own BVH, keep `i<j`. Dedup pairs by unordered `key`, drop same-`key`.

Narrow phase (`narrow.ts`), per candidate pair:
1. Gather candidate **triangle** pairs via the two `TriMesh` BVHs (query each tri of the smaller mesh, inflated by `margin`, against the other's tri BVH). This keeps work proportional to actual overlap — no `trisA×trisB`, no decimation.
2. Track `intersects`, `minDist`, and closest points across candidate tri pairs (`triTriIntersect` → 0 distance / contact; else `triTriDistance`).
3. Classify:
   - `intersects` → `status:'hard'`, `distance = -penetrationEstimate` (P0 estimate = AABB min-axis overlap of the contact region; **exact penetration deferred to Rust, Phase 3** — documented in code), `point = ` centroid of intersecting tri midpoints.
   - else `gap = minDist`: `gap < tolerance` → `'touch'`; else `mode==='clearance' && gap ≤ clearance` → `'clearance'`; else → `null`.
   - `'touch'` is filtered out unless `rule.reportTouch` (default false).
4. `severity = rule.severity ?? inferClashSeverity(tagA, tagB)`.

`TsClashEngine.run`: for each rule → select A/B by `matchesSelector(el.tag, sel)` → broad → drop excluded pairs → narrow → collect. Assign `clash.id = stableHash(min(keyA,keyB)|max|ruleId)`. Honor `settings.signal` (throw `AbortError` between pairs) and `settings.onProgress`. Sort clashes by `(keyA,keyB,rule)`. Build `summary` (`byRule`,`byTypePair`,`bySeverity`,`byStorey?`). Enforce `maxCandidatePairs` → populate `result.truncated` (never silent).

### `elementsFromStep` (adapter)

Input `{ store: IfcDataStore; meshes: MeshData[]; modelId: string; federation?: FederationRegistry; worldTransform?: Mat4 }`. For each mesh with `positions.length`:
- `ref = federation ? federation.toGlobalId(modelId, expressId) : expressId`
- `key = new EntityNode(store, expressId).globalId` (cached getter — never `extractEntityAttributesOnDemand` in the loop, per `AGENTS.md`)
- `tag = store.entities.getTypeName(expressId)` (PascalCase) — fallback `mesh.ifcType`
- `name`, `storey = node.storey()?.name`
- `bounds = aabb.fromPositions(positions)` (apply `worldTransform` if present for federation alignment)
- exclusions: `node.voids()` → openings; each opening `.filledBy()` → fillers ⇒ exclude `(key, fillerKey)`; `node.decomposes()`/`decomposedBy()` siblings ⇒ exclude same-assembly pairs.

### Tests (`vitest`)

- `selectors.test.ts` — wildcard/pipe/exclusion grammar.
- `disciplines.test.ts` — `inferClashSeverity` for known pairs (MEP×STR=critical, ELEC×MEP=minor).
- `math/triangle.test.ts` — analytic: crossing triangles intersect; coplanar-separated don't; `triTriDistance` equals known gaps for axis-aligned pairs; touching = 0.
- `engine-ts/engine.test.ts` — golden fixtures built in code: two unit boxes overlapping → 1 hard; separated by 0.1 m, clearance 0.05 → none, clearance 0.2 → 1 clearance; touching faces → suppressed unless `reportTouch`; exclusion set drops an expected pair.
- `adapters/step.test.ts` — synthetic minimal `IfcDataStore` + `MeshData[]` → elements have correct `key/tag/bounds`; void/fill exclusion present.

### Changeset / wiring
- `"private": true` → no changeset yet.
- `turbo.json`/`pnpm-workspace.yaml` pick up `packages/*` automatically; confirm `build` + `test` run.
- Add to `knip.json` only if knip flags the new entry (on-demand, per project policy — no new CI job).

### Acceptance
`pnpm --filter @ifc-lite/clash build && pnpm --filter @ifc-lite/clash test` green. Importing `@ifc-lite/clash` (core) does **not** resolve `@ifc-lite/parser` (verify with `knip`/import graph). All golden cases classify correctly.

---

## Phase 1 — worker + web viewer panel

**Outcome:** interactive clash in the web viewer, off the main thread.

### Files

| File | Action | Notes |
|---|---|---|
| `packages/clash/src/clash.worker.ts` | create | `onmessage` → `engine.run`; posts `{type:'progress'}` and `{type:'result'}`; `AbortSignal` via `{type:'cancel'}`. Exported via `./worker` subpath |
| `packages/clash/src/worker-client.ts` | create | `createClashWorkerClient(worker): { run(elements,rules,settings): Promise<ClashResult>; cancel() }` (Transferable mesh buffers) |
| `apps/viewer/src/store/slices/clashSlice.ts` | create | mirror `idsSlice.ts`: `clashResult`, `clashRules`, `clashRunning`, `clashError`, `clashGroupBy`, `selectedClashId`, filters/sort + setters |
| `apps/viewer/src/store/types.ts` | modify | add `ClashSlice` to the composed store type |
| `apps/viewer/src/store/index.ts` (store composition) | modify | register `createClashSlice` |
| `apps/viewer/src/hooks/useClash.ts` | create | gather aligned elements from loaded models (`geometryResult.meshes` + `ifcDataStore` + `FederationRegistry` via `elementsFromStep`), run worker, apply results |
| `apps/viewer/src/components/viewer/ClashPanel.tsx` | create | list + discipline-matrix presets + run/cancel + group-by + severity badges; row click → highlight |
| panel registration (sidebar/dock, e.g. `App.tsx`) | modify | add Clash panel toggle beside IDS/BCF |

### Integration symbols (use existing)
- Selection: `addEntitiesToSelection(refs)`, `setSelectedEntity(ref)` (`selectionSlice.ts`).
- Isolate: `hideEntitiesInModel(modelId, ids)` / `showEntitiesInModel` / `clearModelVisibility` (`visibilitySlice.ts`).
- Color: the viewer's color-override action used by Lens — **VERIFY exact name** in `lensSlice.ts`/renderer (`scene.setColorOverrides(Map<number,RGBA>)`; desktop equivalent was `setPendingColorUpdates`). A=red `[1,0,0,1]`, B=orange `[1,0.5,0,1]`.
- Camera: `cameraCallbacks.frameSelection()`, `applyViewpoint(viewpoint)` (`store/types.ts:233`).
- Section: `SectionPlane` setter (`sectionSlice.ts`) for "slice to clash".

### Tests
- `clashSlice` reducer test (set/clear/filter).
- `useClash` integration smoke (jsdom): mock store, assert color map + selection built from a fake `ClashResult`.

### Acceptance
Load a model → ClashPanel → run a discipline preset → clashing elements color red/orange; click frames the pair; UI does not freeze (worker). `"private"` still — no changeset.

---

## Phase 2 — sensible BCF (the headline)

**Outcome:** clash results become a *manageable* set of grouped, deduplicated, lifecycle-ready BCF topics.

### Files

| File | Action | Key API |
|---|---|---|
| `packages/clash/src/grouping.ts` | create | `groupClashes(result, { by:'cluster'\|'rule'\|'typePair'\|'element'\|'storey', epsilon?, maxGroups?, maxPerGroup? }): ClashGroup[]` |
| `packages/clash/src/bcf-bridge.ts` | create | `createBCFFromClashResult(result, groups, opts): BCFProject`; `mapBcfToClashes(project, result): Map<clashId, status>` |
| `packages/clash/src/deterministic-uuid.ts` | create (or reuse `@ifc-lite/encoding`) | `uuidFromSeed(seed: string): string` (stable hash → RFC-4122 shape) — **VERIFY** encoding doesn't already export one |
| `package.json` | modify | add `@ifc-lite/bcf`, `@ifc-lite/encoding` deps (reached only via `./bcf` subpath) |

### Grouping detail
- **`cluster` (default):** DBSCAN over clash `point`s within `epsilon` (default 1.5 m), **partitioned by `(rule, disciplinePair, storey)`** so unrelated trades never merge. Each cluster → `ClashGroup{ id, title, members, bounds, representativePoint, severity:max, discipline, storey }`. `id = uuidFromSeed(sorted member ids)` for stability.
- `maxPerGroup`/`maxGroups` enforced with transparency (group records dropped counts).

### BCF bridge detail (uses confirmed `@ifc-lite/bcf` API)
Per group → `createBCFTopic({ title, description, author, topicType:'Clash', topicStatus:opts.status, priority: severity→{critical:'High',…}, labels:[discipline,'Clash'] })` with **`guid = uuidFromSeed(group.id)`** (deterministic → re-export updates, not duplicates). Then `createViewpoint({ camera: framed on group.bounds (viewer frame; `cameraToPerspective` converts Y-up→Z-up), selectedGuids: member keys, coloredGuids:[{color:'FFFF3333',guids:setA},{color:'FFFFA500',guids:setB}], sectionPlane?: box around bounds, snapshotData?: await opts.snapshotProvider?.(group) })` → `addViewpointToTopic` → `addTopicToProject`. Member overflow beyond `maxPerGroup` → CSV summary in `description`/comment, never dropped silently. `maxTopics` (default 1000) caps topic count with a transparency note.

### Tests
- `grouping.test.ts` — 1000 co-located synthetic clashes in 3 spatial clusters → 3 groups; `maxPerGroup` caps + reports overflow.
- `bcf-bridge.test.ts` — N clashes → ≤`maxTopics` topics; topic GUID stable across two runs (deterministic); `writeBCF` → valid `.bcfzip`; `readBCF` round-trip → `mapBcfToClashes` recovers status by GUID.

### Consumer wiring
- Viewer ClashPanel "Export to BCF" → `createBCFFromClashResult` with a `snapshotProvider` using `useBCF().captureSnapshot`; "Open BCF" → `mapBcfToClashes` to show statuses.

### Acceptance
Grouped export verified; deterministic GUIDs; headless path works without snapshots.

---

## Phase 3 — Rust/WASM core

**Outcome:** production performance (1M-tri models, no freeze) behind the same `ClashEngine` interface; TS engine becomes the differential oracle.

### Files

| File | Action | Notes |
|---|---|---|
| `rust/clash/Cargo.toml` | create | crate `ifc-lite-clash`; minimal deps (own vec math or shared util) |
| `rust/clash/src/lib.rs` | create | `pub struct ClashSession` — `ingest`, `build`, `run_rules`, `take_results`, drop=free |
| `rust/clash/src/{element,broad,narrow,distance,exclude,report}.rs` | create | broad = BVH + dual-tree overlap (SAP fallback); narrow = exact tri-tri (Guigue–Devillers) + **exact penetration depth**; distance = exact tri-tri min-dist; exclude = pair sets; report = packed serialization |
| `Cargo.toml` (workspace) | modify | add `rust/clash` to members |
| `rust/wasm-bindings/Cargo.toml` | modify | add `ifc-lite-clash` dep |
| `rust/wasm-bindings/src/api/clash.rs` | create | `#[wasm_bindgen] impl IfcAPI`/`ClashSession`: flat-array `ingest(ids, tags_interned, aabbs, positions_arena, ranges)`, `build()`, `run_rules(json)->packed`, `free()` |
| `rust/wasm-bindings/src/api/mod.rs` | modify | register `clash` module |
| `packages/clash/src/engine-wasm/index.ts` | create | `WasmClashEngine` — binds `@ifc-lite/wasm` `ClashSession`; serialize rules→JSON; ingest `MeshData`; decode packed results |
| `packages/clash/src/engine-wasm/pool.ts` | create | shard candidate pairs across N workers (reuse `geometry-parallel` pattern) — sub-step 3b |
| `packages/clash/src/engine.ts` | modify | `backend:'auto'` → detect WASM (browser + Node) else TS |
| `packages/clash/test/differential.test.ts` | create | run TS + WASM on shared fixtures; assert identical pairs, distances within ε |

### Build/CI note (from `AGENTS.md`)
`scripts/build-wasm.sh` builds `rust/wasm-bindings` and runs in **four** workflows (`test.yml`, `release.yml`, `desktop-compat.yml`, `sdk-canary.yml`). Adding a **pure-Rust** crate with **no new system/toolchain deps** does *not* require editing those workflows — only changes to Rust channel / `wasm-pack` / LLVM-clang version do. Confirm `ifc-lite-clash` adds no such deps. Do not hand-edit `packages/wasm/pkg/*`; regenerate; `git checkout` the two generated `pkg/{README,package.json}` churn files.

### Threading
No COOP/COEP today → scale via the existing N-worker pool (`pool.ts`), each worker its own WASM `ClashSession`. Note `wasm-bindgen-rayon` as a future in-instance upgrade if cross-origin isolation is enabled.

### Acceptance
`differential.test.ts` green (TS≡WASM on fixtures). A 1M-triangle model clashes within target wall-clock. `backend:'auto'` picks WASM in browser + Node. **Flip `packages/clash` to public + add the first changeset (`1.0.0`) here.**

---

## Phase 4 — MCP + scripts + CLI

**Outcome:** headless + agentic clash; couples to automation.

### Dependency note
Clash needs triangle meshes. MCP/CLI must mesh headlessly via the existing WASM-in-Node path (the CLI already does GLB/geometry export → confirm `HeadlessBackend` exposes a mesh-producing call; reuse it). Flag: if no headless mesh API exists, add a thin `meshModel(store): MeshData[]` helper in the geometry bridge first.

### Files

| File | Action | Notes |
|---|---|---|
| `packages/mcp/src/tools/clash.ts` | create | `clash_check` (impl, replaces stub), `clash_matrix`, `clash_report` Tools; `scope:'read'`; resolve A/B GlobalIds via `entityIndex.byType`+`EntityNode`; mesh via headless bridge; run engine; return grouped result + `progress`/`signal` |
| `packages/mcp/src/tools/geometry.ts` | modify | remove the `clash_check` stub (:229); re-export from `clash.ts` registration |
| `packages/mcp/src/server.ts` (or tool registry index) | modify | `registerAll([...clashTools])` |
| `packages/sdk/...` (locate `bim` namespace registry) | modify | add `bim.clash` namespace: `run(selA, selB, opts)`, `matrix(presets)`, `toBcf(result, opts)` |
| `packages/sandbox/src/bridge-schema.ts` | modify | expose `bim.clash.*` in `NAMESPACE_SCHEMAS` (serializable `ClashResult`) |
| `packages/cli/src/commands/clash.ts` | create | `ifc-lite clash <file> --a <sel> --b <sel> --mode hard\|clearance --tolerance --clearance --matrix --group cluster --bcf out.bcfzip --json` |
| `packages/cli/src/...` (command registry) | modify | register `clash` |

### Tests
- `tools/clash.test.ts` (synthetic model) — returns grouped clashes; honors read scope.
- `commands/clash.test.ts` — `--json` shape; `--bcf` writes a valid archive.
- `bim.clash` sandbox eval test.

### Acceptance
`ifc-lite clash file.ifc --matrix --bcf out.bcfzip` works headless; MCP `clash_check` returns grouped results; `clash_review` prompt (`prompts/templates.ts:133`) drives it; `bim.clash.run(...)` works in a script. Changesets for `mcp`/`cli`/`sdk`/`sandbox`.

---

## Phase 5 — clash lifecycle / revisions

**Outcome:** clash becomes a tracked workflow across model revisions.

### Files
| File | Action | API |
|---|---|---|
| `packages/clash/src/lifecycle.ts` | create | `compareClashRuns(prev: ClashResult, next: ClashResult): { added: Clash[]; persistent: Clash[]; resolved: Clash[] }` (by `clash.id`); `applyBcfStatus(result, project): ClashResult` |
| `apps/viewer/src/store/slices/clashSlice.ts` | modify | carry per-clash status; panel new/persistent/resolved badges |

Identity is stable because `clash.id` is built from durable `key`s (GlobalIds), and those persist across revisions exactly as `computeDiff` (the existing diff engine) relies on. Optionally feed `computeDiff` output to remap a renamed/replaced element.

### Acceptance
Two runs over a revised model classify added/persistent/resolved; BCF status persists via deterministic topic GUID.

---

## Phase 6 — IFC5 / USD adapter

**Outcome:** clash on IFC5/USD with **zero core changes** — the architecture's proof.

### Files
| File | Action | Notes |
|---|---|---|
| `packages/clash/src/adapters/ifcx.ts` | create | `elementsFromIfcx({ composition, geometry }): { elements; exclusions }` — `key = prim path`, `tag = component/schema type`, geometry from `@ifc-lite/ifcx` `geometry-extractor` |
| `package.json` | modify | add `@ifc-lite/ifcx` (reached only via `./ifcx` subpath) |
| `src/adapters/ifcx.test.ts` | create | ifcx fixture → elements; run engine; clashes found with the *same* engine/grouping/bcf code |

### Acceptance
A USD/IFCx fixture clashes through the unchanged core + grouping + BCF bridge. No edits to `engine-ts`, `engine-wasm`, `grouping`, or `bcf-bridge`.

---

## Phase 7 — desktop migration

**Outcome:** single source of truth; delete the fork.

### Files (in `ifc-lite-desktop`)
| File | Action |
|---|---|
| `src/desktop/analysis/clash-engine.ts` | **delete** — replaced by `@ifc-lite/clash` + `@ifc-lite/clash/step` |
| `src/desktop/analysis/clash-disciplines.ts` | **delete** — now in package |
| `src/desktop/analysis/clash-triage.ts` | replace with `@ifc-lite/clash` `triage.ts` (or thin wrapper) |
| `src/desktop/analysis/useDesktopAnalysis.ts` | modify — call package engine + grouping + bcf-bridge; keep colors/isolation/triage UX |
| `src/views/ClashPanel.tsx` | keep (UI); rewire to package types |
| `package.json` | add `@ifc-lite/clash` |

### Acceptance
Desktop uses the shared package; private engine deleted; `desktop-compat.yml` + desktop build/tests green. (Commits here: respect the **no Claude co-author trailer** repo preference.)

---

## Cross-phase dependency graph

```
P0 (core+TS engine+step) ──┬─> P1 (worker+panel) ──┐
                           ├─> P2 (grouping+BCF) ───┼─> P4 (MCP/CLI/scripts) ─> P5 (lifecycle)
                           └─> P3 (Rust/WASM) ──────┘
P0 ───────────────────────────────────────────────────> P6 (IFCx adapter)
P0..P4 ───────────────────────────────────────────────> P7 (desktop migration)
```

P1, P2, P3 all depend only on P0 and can proceed in parallel. P4 wants P2 (grouped output) + ideally P3 (speed). P6 needs only P0. P7 wants P0–P2 (+P3 for parity).

## Definition of done (whole effort)
- One `@ifc-lite/clash` package; core import graph free of STEP/IFCx/BCF.
- WASM engine ≡ TS engine on fixtures; runs off-main-thread; scales to 1M+ tris.
- BCF export is grouped, deduplicated, deterministic, lifecycle-aware, with transparent caps.
- MCP `clash_check`/`clash_matrix`/`clash_report`, `ifc-lite clash`, and `bim.clash.*` all live.
- IFC5/USD works via an adapter with zero core changes.
- Desktop consumes the package; the prototype engine is deleted.
```
