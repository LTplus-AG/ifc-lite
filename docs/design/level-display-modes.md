# Phase 6 — Level Display Modes (design)

**Status:** plan only — not yet implemented.

Pascal Editor's `LevelSystem` lets users switch between **Stacked**
(default), **Exploded** (storeys lifted on Y), and **Solo** (only one
storey visible). The bones for Solo already exist in ifc-lite via
the floorplan dropdown + `isolateEntities`; Exploded needs renderer
support that doesn't exist today. This doc maps both paths.

## State surface

Add a new slice `levelDisplaySlice` so the mode lives in one place
and isn't tangled with the existing isolate / floorplan state:

```ts
type LevelDisplayMode = 'stacked' | 'exploded' | 'solo';

interface LevelDisplaySlice {
  levelDisplayMode: LevelDisplayMode;
  /** Active storey for Solo. Null = first storey of activeModel. */
  soloStoreyExpressId: number | null;
  /** Per-storey explosion gap, metres. Default 4. */
  explodedGap: number;
  setLevelDisplayMode(mode: LevelDisplayMode): void;
  setSoloStoreyExpressId(id: number | null): void;
  setExplodedGap(metres: number): void;
}
```

Defaults: `mode = 'stacked'`, `gap = 4`, `soloStoreyExpressId = null`.

## Implementation paths

### Solo — cheap, ship immediately

- Walk `dataStore.spatialHierarchy.elementToStorey` to collect every
  entity in `soloStoreyExpressId`.
- Call existing `setIsolatedEntities(Set<expressId>)`.
- Exit Solo → `setIsolatedEntities(null)`.
- Wire the active storey from the existing storey dropdown in the
  toolbar (already populated by `useFloorplanView`).
- **Zero renderer changes.** ~80 LOC.

### Stacked → Exploded → Stacked

This is the renderer-touching path. Two options:

| | A. Mutate mesh positions in JS | B. Renderer per-entity offset |
|---|---|---|
| Where the offset lives | In-place edits on each `MeshData.positions: Float32Array` | New `Scene.setEntityOffsets(Map<expressId, Vec3>)` API |
| Renderer churn | Zero | Pipeline change (uniform buffer or instance attr) + shader change |
| Cost per toggle | One-time **O(total vertices)** — e.g. ~100 ms on a 10 M-vertex model | One-time uniform/buffer rebuild — negligible |
| Cost per frame (smooth lerp) | Same O(vertices) every frame — too expensive | Free |
| Multi-model | Loop per model | Per-model offset map |
| Risk | Easy to undo wrong (must remember old offset) | Touches the hot render path |

**Recommendation: ship Option A first, plan Option B as a follow-up.**

Reasoning: Pascal's smooth Y-lerp animation is nice but it's not
load-bearing for the feature. Discrete mode toggles cover 95% of the
UX value. We can revisit Option B if user feedback wants animation.

### Option A — implementation sketch

```ts
// new helper apps/viewer/src/lib/level-offsets.ts
export function applyExplodedOffsets(
  result: GeometryResult,
  spatialHierarchy: SpatialHierarchy,
  gap: number,
): () => void {
  // Sort storeys by elevation ascending. Index 0 stays at its
  // existing elevation; subsequent storeys lift by
  // `(index - 0) * gap - elevationDelta` so they end up at
  // `index * gap` in world Y.
  const storeyOrder = [...spatialHierarchy.storeyElevations.entries()]
    .sort(([, a], [, b]) => a - b);
  const offsets = new Map<number /* storeyId */, number /* dY */>();
  const baseElevation = storeyOrder[0]?.[1] ?? 0;
  storeyOrder.forEach(([storeyId, elevation], i) => {
    offsets.set(storeyId, baseElevation + i * gap - elevation);
  });

  // Apply to every mesh whose entity maps to a storey.
  const applied: Array<{ mesh: MeshData; dy: number }> = [];
  for (const mesh of result.meshes) {
    const storeyId = spatialHierarchy.elementToStorey.get(mesh.expressId);
    if (storeyId === undefined) continue;
    const dy = offsets.get(storeyId);
    if (dy === undefined || dy === 0) continue;
    for (let i = 1; i < mesh.positions.length; i += 3) {
      mesh.positions[i] += dy;  // renderer Y-up
    }
    applied.push({ mesh, dy });
  }

  // Return a revert closure — keeps the offset record local so we
  // don't have to recompute it on exit.
  return () => {
    for (const { mesh, dy } of applied) {
      for (let i = 1; i < mesh.positions.length; i += 3) {
        mesh.positions[i] -= dy;
      }
    }
  };
}
```

A `useEffect` in `Viewport.tsx` runs this on mode change:

```ts
useEffect(() => {
  if (levelDisplayMode !== 'exploded') return;
  const revert = applyExplodedOffsets(geometryResult, spatialHierarchy, explodedGap);
  scene.markDirty();  // force re-upload
  return () => {
    revert();
    scene.markDirty();
  };
}, [levelDisplayMode, explodedGap, geometryResult, spatialHierarchy]);
```

The `scene.markDirty()` call is the existing renderer's
"positions changed, re-upload" trigger — same path
`updateMeshPositions` uses for georef nudges.

### Federated models

Each model has its own `spatialHierarchy`. Apply the offset per
model. For an outer building-level explosion (rare but Pascal-y), add
a `modelIndex × buildingGap` to every storey's offset.

## UI

### Toolbar dropdown

New `LevelDisplayDropdown` between the floorplan dropdown and the
class-visibility dropdown in `MainToolbar.tsx`:

```
[ Floorplan ▾ ] [ View ▾ ] [ Layers ▾ ]
                  │
                  ├ ◯ Stacked
                  ├ ◯ Exploded   gap: [ 4 m ▾ ]
                  └ ◯ Solo       storey: [ Ground Floor ▾ ]
```

- The View pill carries a small accent dot when not Stacked.
- "Gap" and "Storey" sub-controls render inline only when their mode
  is selected — avoids permanent clutter.

### Keyboard

No new single-letter shortcuts (the alphabet is full). Add via
command palette: "View — Stacked / Exploded / Solo".

## Edge cases

| | Handling |
|---|---|
| Storey at extreme negative elevation (basement) | Still gets a non-negative index (sort by elevation puts basement at index 0) |
| Storey without elevation in `spatialHierarchy` | Fall back to bbox-Y mean of contained meshes |
| Entity not mapped to a storey (e.g. `IfcSite`) | No offset applied — sits at its native Y |
| New entity added during Exploded mode | Mesh inherits storey transform via the existing geometry pipeline; the offset hook runs on mesh-add too |
| Mode swap during a draw operation | Cancel the draw tool (`setActiveTool('select')`) before applying offsets |
| Federated model loaded while Exploded | Recompute offsets including the new model's storeys |

## Test surface

- `levelDisplaySlice.test.ts` — state transitions, default, persistence skip
- `applyExplodedOffsets.test.ts` — pure offset math against a synthetic
  `GeometryResult` + `SpatialHierarchy`, including multi-storey
  ordering and revert symmetry
- Manual: toggle each mode in a 3-storey model, confirm reverts
  cleanly; do it with a federated multi-model session; commit a
  mutation while in Exploded and confirm undo doesn't lose the
  offset

## LOC + commit shape

- `levelDisplaySlice.ts` (~80) + test (~80)
- `applyExplodedOffsets` helper (~80) + test (~120)
- `LevelDisplayDropdown` toolbar component (~120)
- `Viewport.tsx` effect wiring (~30)
- Command palette entries (~30)

Total ~540 LOC, single PR.

## Option B (renderer per-entity offset) — for the follow-up

When animation becomes desirable, add to `@ifc-lite/renderer`:

```ts
class Scene {
  // ...
  setEntityOffsets(offsets: Map<number, [number, number, number]>): void;
}
```

The render pipeline picks this up via a per-mesh storage buffer
(WebGPU; bind group resource that the vertex shader samples by mesh
id). Pure transform — no vertex buffer rewrites, no GPU reuploads.
Animation then becomes a JavaScript-side `requestAnimationFrame` that
lerps the offset map between current and target across N frames; the
renderer redraws each frame with no per-frame upload.

Estimated work: ~400 LOC in `@ifc-lite/renderer`, +60 in viewer.
Worth doing only when the discrete Option A ships and users ask for
animation.
