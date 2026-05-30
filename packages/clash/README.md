# @ifc-lite/clash

Clash detection for IFC-Lite. A **representation-agnostic** core engine plus thin,
version-specific **source adapters**.

- The core (`@ifc-lite/clash`) operates on `ClashElement[]` — `{ key, ref, tag, bounds, positions, indices }` —
  and never imports `@ifc-lite/parser`/`@ifc-lite/query`. STEP/IFC4 and IFC5/USD are
  just adapters that produce those elements.
- Broad phase: BVH (`@ifc-lite/spatial`). Narrow phase: exact triangle–triangle
  intersection and exact triangle–triangle minimum distance — no decimation.
- Results classify as `hard` (interpenetration), `clearance` (within a gap), or `touch`
  (within tolerance, suppressed by default).

```ts
import { createClashEngine, CLASH_RULE_PRESETS } from '@ifc-lite/clash';
import { elementsFromStep } from '@ifc-lite/clash/step';

const { elements, exclusions } = elementsFromStep({ store, meshes, modelId: 'm1' });
const engine = createClashEngine({ backend: 'auto' });
const result = await engine.run(elements, [
  { id: 'mep-str', name: 'MEP vs Structure', a: 'IfcPipe*|IfcDuct*', b: 'IfcBeam|IfcColumn|IfcSlab', mode: 'hard' },
], { exclusions });

console.log(result.summary.total, 'clashes');
```

Status: **Phase 0** — TypeScript reference engine + STEP adapter. The Rust→WASM core,
worker, grouping, and BCF bridge land in later phases (see
`docs/architecture/clash-detection-implementation.md`).
