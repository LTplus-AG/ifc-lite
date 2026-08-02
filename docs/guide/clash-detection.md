# Clash Detection

The `@ifc-lite/clash` package finds geometric interferences between building elements, ducts through walls, pipes through beams, columns overlapping slabs, and turns them into a coordination workflow with review status and BCF export. The engine is representation-agnostic: it operates on plain world-frame triangle meshes plus a durable element key, so the same core serves IFC (STEP), IFCx, and anything else behind a small source adapter.

## Concepts

A clash run takes a list of **elements** (each with geometry and identity) and a list of **rules**, and returns classified **clashes**.

- **Mode** decides what a rule looks for. `hard` finds interpenetration beyond a tolerance; `clearance` finds elements that are separated but closer than a required gap.
- **Status** classifies a detected pair as `hard`, `clearance`, or `touch` (touching is suppressed unless a rule opts in).
- **Severity** (`critical`, `major`, `minor`, `info`) is set explicitly on a rule or inferred from the discipline matrix.
- **Identity is split.** Each element carries a durable `key` (IfcGUID or USD prim path) used for persistence, dedup, and BCF, and a runtime `ref` (federated globalId or express id) used for selection and coloring in a renderer.

## Library usage

The core entry point is `createClashEngine`. Feed it elements and rules; it returns a `ClashResult` with the classified clashes and a summary.

```ts
import { createClashEngine, type ClashElement, type ClashRule } from '@ifc-lite/clash';

// Elements carry world-frame triangles plus identity. A source adapter builds
// these from your store (see below); here is the shape it produces.
const elements: ClashElement[] = [
  {
    key: '2O2Fr$t4X7Zf8NOew3FLKr',   // durable IfcGUID
    ref: 42,                          // runtime handle for the renderer
    model: 'mep.ifc',
    tag: 'IfcDuctSegment',
    bounds: ductBounds,
    positions: ductPositions,         // Float32Array, world frame
    indices: ductIndices,             // Uint32Array
  },
  // ...walls, pipes, beams
];

const rules: ClashRule[] = [
  { id: 'duct-vs-wall', name: 'Ducts vs walls', a: 'IfcDuct*', b: 'IfcWall*', mode: 'hard' },
];

const engine = createClashEngine({ backend: 'ts' });
const result = await engine.run(elements, rules);

console.log(`${result.summary.total} clashes`);
console.log(result.summary.bySeverity); // { critical, major, minor, info }
```

Selectors are glob-and-union patterns matched against the element `tag`: `IfcDuct*|IfcPipe*` matches either family, and a leading `!` negates (`!IfcSpace`). Omit a rule's `b` to run a self-clash within selection `a`.

!!! note "Backends"
    `createClashEngine({ backend: 'ts' })` uses the in-process TypeScript
    reference engine. A Rust/WASM backend is opt-in via a separate subpath
    import (`@ifc-lite/clash/wasm`) because it needs an async module init; the
    TS backend applies a deterministic per-rule candidate-pair cap (reported in
    `result.truncated`) while the WASM kernel runs every pair uncapped.

### Source adapters

Elements rarely come hand-built. The package ships adapters that map a parsed store plus its meshes into `ClashElement`s, and return a pair-exclusion set (voids, hosts, assemblies that should never be reported as clashing):

```ts
import { elementsFromStep } from '@ifc-lite/clash/step';

const { elements, exclusions } = elementsFromStep({ store, meshes, modelId });
const result = await engine.run(elements, rules, { exclusions });
```

The STEP adapter lives at `@ifc-lite/clash/step` and the IFCx adapter at `@ifc-lite/clash/ifcx`, kept behind subpath exports so the core import graph stays free of version-specific dependencies. That boundary is what keeps IFC5 support a new adapter rather than a rewrite.

### The discipline matrix

Instead of writing rules by hand, generate the standard coordination matrix. `disciplineMatrixRules(mode, clearance?)` expands the built-in discipline definitions (ARCH, STR, MEP, HVAC, ELEC, FIRE, GEO) into a cross-discipline rule set with inferred severities:

```ts
import { disciplineMatrixRules } from '@ifc-lite/clash';

const rules = disciplineMatrixRules('hard');
const result = await engine.run(elements, rules, { exclusions });
```

## CLI usage

The [`clash` command](cli.md#clash-clash-detection) meshes the model headlessly, maps it through the STEP adapter, and runs the engine, so you never touch the library for a one-shot check.

```bash
# Standard discipline matrix
ifc-lite clash model.ifc --matrix
ifc-lite clash model.ifc --matrix --json

# Ad-hoc rule: ducts and pipes vs walls, 5 cm clearance
ifc-lite clash model.ifc --a "IfcDuct*|IfcPipe*" --b "IfcWall*" --mode clearance --clearance 0.05

# Self-clash within a selection (omit --b)
ifc-lite clash model.ifc --a "IfcPipeSegment*"

# Export clashes as a BCF archive
ifc-lite clash model.ifc --matrix --bcf clashes.bcfzip
```

| Flag | Description |
|------|-------------|
| `--matrix` | Run the standard discipline matrix rules |
| `--a <pattern>` | Type pattern for set A (glob, `\|`-separated; default `*`) |
| `--b <pattern>` | Type pattern for set B (omit for a self-clash within A) |
| `--mode <m>` | `hard` (default) or `clearance` |
| `--tolerance <m>` | Penetration tolerance in metres (hard mode) |
| `--clearance <m>` | Required clearance in metres (clearance mode) |
| `--bcf <file>` | Write results as a BCF archive |
| `--group <g>` | BCF topic grouping: `cluster` (default), `rule`, `typePair`, `element` |
| `--bcf-status <s>` | Topic status for exported BCF topics |
| `--max-topics <N>` | Cap the number of BCF topics |
| `--json` | JSON output |

The human summary reports the total, a severity breakdown, and the top clashes with their signed distance (`penetration 0.043m` or `gap 0.012m`). `--json` emits the full summary and clash list (capped for display).

## Review workflow

Detection tells you a clash exists; **review** records what the team decided about it. That coordination state is deliberately separate from the detection `status`:

- Each clash gets a review status of `open`, `resolved`, or `accepted`, plus an optional free-text comment.
- Review state is persisted against a **durable key**, `clashReviewKey(clash)`, built from the rule id and the two elements' durable keys, order-independent. Because it never embeds the ephemeral runtime model id, a review re-attaches to the same clash after a page reload, a re-run, or a new model revision, the Navisworks "status carries across versions" behaviour.
- When a BCF topic bundles several clashes, `aggregateReviewStatus` collapses them least-resolved-wins: a topic is only done once every member is, and a single still-open member keeps the whole topic open.

```ts
import { clashReviewKey, aggregateReviewStatus, reviewStatusToBcfTopicStatus } from '@ifc-lite/clash';

const key = clashReviewKey(clash);          // durable, survives reload / revision
reviews.set(key, { status: 'accepted', comment: 'Coordinated with structural' });

const topicStatus = aggregateReviewStatus(members.map((c) => reviews.get(clashReviewKey(c))?.status ?? 'open'));
```

### BCF export

`groupClashes` clusters related clashes into the unit of a single BCF topic, and `createBCFFromClashResult` (from `@ifc-lite/clash/bcf`) turns those groups into a BCF project you write with `@ifc-lite/bcf`. On export, review status maps to a BCF 2.1 `TopicStatus` through `reviewStatusToBcfTopicStatus`, using only the two universally supported statuses (`Open` and `Closed`) so any BCF tool round-trips the archive. Both `resolved` and `accepted` are terminal and close the topic; the finer distinction is preserved in the topic description rather than the status field. See the [BCF Collaboration](bcf.md) guide for the round-trip.

For the full API, see the [`@ifc-lite/clash` README](https://github.com/LTplus-AG/ifc-lite/tree/main/packages/clash).
