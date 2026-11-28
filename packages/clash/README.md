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

## Installation

```bash
npm install @ifc-lite/clash
```

## Usage

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

If your host has already shifted `mesh.expressId` into a federated global id
space (as the viewer's loader does for every model past the first) while the
`IfcDataStore` keeps local ids, pass that shift as `meshIdOffset` so the adapter
can address the store correctly:

```ts
import { elementsFromStep, type FederationLike } from '@ifc-lite/clash/step';

declare const federation: FederationLike; // e.g. the renderer's FederationRegistry
declare const model: { idOffset: number };

elementsFromStep({ store, meshes, modelId, federation, meshIdOffset: model.idOffset });
```

`ClashElement.key` is the element's IFC GlobalId. An element that has none — a
malformed root, or every element of a GLB-sourced model, whose store carries no
IFC entities — falls back to `expressid:<encoded modelId>:<expressId>`. Express
ids are only unique within a model, so the model id is part of that key:
`clashReviewKey` and the viewer's element-pair exclusions key on the element key
alone, and an unqualified fallback would let a review or an exclusion set on one
model apply to another model's element. That fallback is stable only for as long
as the host's `modelId` is (in the viewer it is a per-load uuid).

### Runs per coordination round

A host that federates models as slots (one discipline model per stable slot id,
pinned to an exact sha256 per round) can store each run and compare rounds:

```ts
import {
  buildClashRunDocument,
  carryForwardReviews,
  compareClashRunDocuments,
  type ClashResult,
  type ClashReview,
  type ClashRule,
  type ClashRunDocument,
  type ExclusionSet,
} from '@ifc-lite/clash';

declare const result: ClashResult;            // a finished run
declare const exclusions: ExclusionSet;       // the exclusions it ran with
declare const rules: ClashRule[];             // the rules it ran
declare const archModelId: string, mepModelId: string, archSha: string, mepSha: string;
declare const previousRun: ClashRunDocument;  // the previous round, read back from storage
declare const previousDecisions: Record<string, ClashReview>;

const run = buildClashRunDocument({
  result,
  rules,                                      // the rules as given to the engine (rulesRun drops explicit members)
  exclusions,
  exclusionRules: [],                         // the user's exclusion rules; [] when there are none (omitted = unknown)
  slots: [{ slot: 'arch', model: archModelId, sha256: archSha }, { slot: 'mep', model: mepModelId, sha256: mepSha }],
  labels: ['browser-submitted'],
});
const diff = compareClashRunDocuments(previousRun, run); // added / persistent / noLongerDetected / notComparable
const { reviews, notCarried } = carryForwardReviews(previousRun, run, previousDecisions);
console.log(diff.summary, Object.keys(reviews).length, notCarried.length);
```

Findings are keyed by `clashSlotReviewKey(clash, { slotOf, ruleRevision })`: each
element is qualified by its slot, and the key changes when a rule keeps its id
but changes its meaning (`clashRuleRevision`). A GlobalId repeated within one
slot gets no key, so no decision is carried to it. A finding the next run did
not report is "no longer detected" only when that run's coverage shows both
elements on opposite sides of the same rule and it did not exclude the pair; otherwise it
is "not comparable", with the reason. Pass `exclusions`, or every finding that
disappears is "not comparable" (`exclusions-not-recorded`). Pass the user's
`exclusionRules` too, `[]` when there are none: findings they cover are left
out of the document, and a pair one run excluded is never reported as added or
fixed. Omitted, they are recorded as unknown and every vanished finding is "not
comparable". Detection change is
separate from review status (open / resolved / accepted).

`CLASH_RUN_DOCUMENT_JSON_SCHEMA` is the document's JSON Schema (version 1 is
closed: unknown properties are refused). `validateClashRunDocument` checks the
same shape plus what a schema cannot: each finding's key follows from its own
elements, rule and revision, revisions match the manifest, ids are unique.
Validate every document you did not build yourself. The viewer hands a
registered host each finished run through `ViewerHandle.onClashRunComplete`
as `{ ok: true, document }` (deeply frozen), or `{ ok: false, error }` when
the document could not be built.

Includes the TypeScript reference engine, a Rust→WASM kernel kept in lockstep by a
differential test (opt-in via `@ifc-lite/clash/wasm`; `backend: 'auto'` currently
resolves to the TS engine), STEP and IFC5/USD source adapters, spatial grouping,
duplicate-element detection, clash review status (open / resolved / accepted) that
round-trips through BCF, and a *sensible* BCF bridge (grouped
topics, deterministic GUIDs, optional snapshots). Surfaced through the viewer's
clash panel, the `ifc-lite clash` CLI, the MCP `clash_check` / `clash_matrix` tools,
and the SDK `clash` namespace.

## Docs

See the [ifc-lite docs](https://ifclite.dev/docs/) and the design
rationale in
[Clash-detection architecture](https://github.com/LTplus-AG/ifc-lite/blob/main/docs/architecture/clash-detection.md).

## License

MPL-2.0
