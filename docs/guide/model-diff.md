# Model Diff

The `@ifc-lite/diff` package compares two revisions of a model and classifies every entity as **added**, **modified**, **deleted**, or **unchanged**. It is a pure, headless, store-agnostic engine: you supply fingerprints, it matches and classifies. The viewer's Compare UI and the [CLI](cli.md) both build on the same core.

## What the engine does

`diffModels(base, head, options?)` takes two iterables of `EntityFingerprint`s and returns a `ModelDiff`:

```ts
import { diffModels } from '@ifc-lite/diff';

const diff = diffModels(baseFingerprints, headFingerprints, { scope: 'both' });

console.log(diff.counts); // { added, modified, deleted, unchanged }
for (const entry of diff.entries) {
  if (entry.state === 'modified') {
    console.log(entry.key, entry.changeKinds); // e.g. ['geometry'] or ['data', 'geometry']
  }
}
```

Entities are matched across revisions by a stable `key`, typically the IFC `GlobalId`. The result carries every entry, a `byKey` map for O(1) lookup (picking in a viewer), and the aggregate `counts`.

### Classification

- `added` — present in head, absent from base.
- `deleted` — present in base, absent from head.
- `modified` — present in both, but an in-scope signal differs. The `changeKinds` array records **which** signals changed (`data`, `geometry`, or both).
- `unchanged` — present in both, no in-scope difference.

### Scope

The `scope` option is the "compare data, geometry, or both" toggle:

| Scope | A modification counts when... |
|-------|-------------------------------|
| `data` | attributes, properties, quantities, or the type assignment differ |
| `geometry` | the mesh shape or placement differs |
| `both` | either (default) |

## What participates in the fingerprint

Each `EntityFingerprint` carries two independent hashes, so data and geometry changes are tracked separately.

**Data hash** — build it with `buildDataFingerprint`, which produces a canonical, order-independent hash over:

- IFC type, `Name`, `Description`, `ObjectType`, `PredefinedType`
- every property set and its properties
- **every quantity set and its quantities** (quantities participate in the data fingerprint)
- type assignments (by the type's `GlobalId`, name, and IFC type)

Property sets, quantity sets, their members, and type assignments are all sorted before hashing, so collection ordering never produces a spurious "modified", and two semantically equal entities in the base and head hash identically.

**Geometry hash** — an opaque fingerprint of the entity's mesh, supplied separately (a `bigint` from the WASM mesh pass, `MeshCollection.geometryHashValues`, or a string for callers that fingerprint geometry another way). Two entities are geometry-equal when both hashes are absent, or both are present and their normalized values match; one side missing means geometry was added or removed.

!!! note "Geometry change is shape/placement, not centroid drift"
    The engine detects geometry change through the mesh hash, not by measuring
    how far an element's bounding-box centre moved. A per-entity "moved by X
    metres" metric is a separate viewer-level concern, not part of the diff
    fingerprint.

## Content-keyed matching (unreliable GlobalIds)

A model re-exported from scratch by another tool gets entirely new GlobalIds, so the key-based match above reports every element as deleted-and-added even when nothing substantive changed. Pass `matchUnpairedByContent: true` to run a second pass, after the normal key-based pass, that re-examines the entities that came out `added`/`deleted` and pairs them by content hash where the pairing is unambiguous:

```ts
import { diffModels } from '@ifc-lite/diff';

const diff = diffModels(baseFingerprints, headFingerprints, { matchUnpairedByContent: true });

for (const match of diff.contentMatches ?? []) {
  if (match.kind === 'renamed' || match.kind === 'moved') {
    console.log(match.kind, match.base[0].key, '->', match.head[0].key);
  } else {
    console.log(match.kind, 'group:', match.base.length, 'base,', match.head.length, 'head');
  }
}
```

- **`renamed`** — the base and head entity's data hash *and* geometry hash both agree; only the key (GlobalId) changed. The `added`/`deleted` pair is removed from `entries`/`byKey`/`counts` in favor of this single record. Under `scope: 'data'` geometry is excluded from the comparison, so every 1:1 match is reported as `renamed`.
- **`moved`** — data hash agrees, geometry hash differs; the key changed and so did the entity's shape/placement. Also removed from `entries` in favor of the record.
- **`duplicated`** — one base entity's content matches several head entities.
- **`deduplicated`** — several base entities' content matches one head entity.
- **`ambiguous`** — more than one entity on *both* sides shares the content hash.

For `duplicated`/`deduplicated`/`ambiguous`, there is no principled way to pick a 1:1 pairing, so the engine does not guess: the original `added`/`deleted` entries stay in `entries` untouched, and `match.base`/`match.head` list every candidate on each side for the caller to resolve.

### Hash collisions

`dataHash` is a 32-bit FNV-1a value, and collisions between genuinely different content are reachable rather than theoretical — the package's tests pin three real ones. The exposure grows with the square of the number of distinct fingerprints compared, and a from-scratch re-export leaves the whole model unpaired. Only the 1:1 path is destructive — it retires a real `added` and a real `deleted` — so it applies two checks that can never reject a genuine match:

- entities are bucketed by `ifcType` as well as `dataHash`. `buildDataFingerprint` already hashes `ifcType`, so identical content always agrees on it; a disagreement proves a collision.
- when both sides carry `components` (from `buildComponentFingerprints`), every sub-hash must agree.

Neither makes the pass collision-proof. FNV-1a's per-character update is a bijection on its 32-bit state, so for two entities differing only inside `attr:core` — a different `Name`, everything else equal — a `dataHash` collision *implies* an `attr:core` collision, and the component check cannot see it. It bites when the differing content sits in a pset or qset slice, whose sub-hash is computed over an unrelated string.

**Supply `components` if you enable this option.** The second check is only active when both revisions carry them, so how much protection you get depends on your adapter:

| what the adapter supplies | collisions caught | collisions still retired as a false match |
| --- | --- | --- |
| `dataHash` only | different `ifcType` | any collision within one `ifcType` |
| `dataHash` + `components` | different `ifcType`; differing pset/qset content | collisions confined to `attr:core` (name, description, object/predefined type) |

`buildComponentFingerprints` takes the same `DataFingerprintInput` you already pass to `buildDataFingerprint`, so populating it is one extra call per entity. Closing the remaining gap outright means widening `stableHash`, which changes every published fingerprint.

Ambiguous groups retire nothing, so a collision landing in one costs the caller an extra candidate to inspect rather than a lost entry.

Split and Merged (a *partial* geometric overlap between one entity and several others) are not implemented — they need a geometric-similarity threshold and a partial-overlap policy with no single correct answer.

`matchUnpairedByContent` defaults to `false`; existing callers of `diffModels` are unaffected. When you do enable it, populate `EntityFingerprint.components` as well — see [Hash collisions](#hash-collisions) for what that buys you.

### Type exclusion

Pass `excludeTypes` to drop classes from the comparison entirely, useful for connective entities like `IfcOpeningElement` that are noise, not meaningful change:

```ts
const diff = diffModels(base, head, { excludeTypes: ['IfcOpeningElement'] });
```

An entity is dropped if its IFC type matches in **either** revision, so a cross-version re-class (for example `IfcWall` becoming `IfcWallStandardCase` with `IfcWall` excluded) can never leak the entity back as a phantom add or delete. Matching is case-insensitive and trims whitespace, so a hand-typed `ifcopeningelement` still matches. The `ModelDiff.excludedTypes` field echoes back exactly what was ignored, normalized, for report provenance.

## CLI usage

The [`diff` command](cli.md#diff-compare-ifc-files) offers a fast, dependency-light comparison focused on counts, per-type deltas, and GlobalId tracking:

```bash
# Entity-count and per-type comparison
ifc-lite diff model-v1.ifc model-v2.ifc

# Add GlobalId-level added/removed/common tracking
ifc-lite diff model-v1.ifc model-v2.ifc --by-entity

# Machine-readable
ifc-lite diff model-v1.ifc model-v2.ifc --json
```

| Flag | Description |
|------|-------------|
| `--by-entity` | Compare entities by GlobalId (added / removed / common) |
| `--json` | JSON output |

Without `--by-entity`, the command reports the schema, entity count, entity-count delta, and the per-type differences (sorted by the size of the delta). With `--by-entity` it adds the count of GlobalIds added, removed, and common between the two files.

!!! tip "CLI diff vs the diff engine"
    The CLI `diff` command answers "what changed at the type and identity
    level" quickly and without meshing. For per-entity `modified` classification
    with data-vs-geometry attribution, drive `@ifc-lite/diff` directly (or use
    the viewer's Compare mode below), supplying the data and geometry hashes.

## Viewer Compare mode

The viewer's Compare UI is a consumer of this engine. It extracts an `EntityFingerprint` per entity from each loaded revision, the data hash from the store and the geometry hash from the WASM mesh pass, and feeds both sides to `diffModels`. The result colours the 3D scene by state (added, modified, deleted), lets you scope the comparison to data, geometry, or both, and drives an inspect panel that reports which signals changed for a picked entity. The persisted type-exclusion list flows straight into `excludeTypes`, so classes the team does not care about stay out of the change set.

For the full API, see the [`@ifc-lite/diff` README](https://github.com/LTplus-AG/ifc-lite/tree/main/packages/diff).
