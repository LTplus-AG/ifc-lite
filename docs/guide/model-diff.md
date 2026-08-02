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
- type assignments — **by the assigned type's name and IFC class only**

Property sets, quantity sets, their members, and type assignments are all sorted before hashing, so collection ordering never produces a spurious "modified", and two semantically equal entities in the base and head hash identically. The sort is **total**: records are ordered by name and then by their own serialized content, because sorting on name alone leaves same-named records in whatever order the adapter walked them (`Array.prototype.sort` is stable), which would put the adapter's iteration order into the hash. Same-named property sets are ordinary in IFC (a type pset and an occurrence pset of one name), so this is a reachable case rather than a theoretical one.

!!! warning "The assigned type's `GlobalId` is not hashed"
    `TypeAssignmentInput` still has a `globalId` field and callers may keep
    populating it — it is useful for display and for resolving the type entity
    — but it does not participate in any hash the package produces.
    `IfcTypeObject` is an `IfcRoot`, so a from-scratch re-export regenerates
    the *type's* GlobalId exactly as it regenerates every product's. Hashing it
    changed the fingerprint of every **typed** element (walls, doors, windows:
    most of a real model) on the very re-export that
    [content-keyed matching](#content-keyed-matching-unreliable-globalids)
    exists to survive, so none of them could pair. Name plus IFC class is the
    part of a type assignment that outlives a re-GUID.

    The cost, stated plainly: two *different* type entities that share a name
    and a class are indistinguishable here, so re-pointing an element from one
    to the other does not move its `dataHash`. That needs duplicate type names
    within one class — a modelling defect, and one a human reader of the model
    cannot see either — and it only surfaces on elements that are otherwise
    identical in every attribute, property and quantity. Assignments are sorted
    but never deduplicated, so an occurrence bound to two types still hashes
    differently from one bound to a single type.

**Geometry hash** — an opaque fingerprint of the entity's mesh, supplied separately (a `bigint` from the WASM mesh pass, `MeshCollection.geometryHashValues`, or a string for callers that fingerprint geometry another way). Two entities are geometry-equal when both hashes are absent, or both are present and their normalized values match; one side missing means geometry was added or removed - unless one whole revision carries no hashes while the other does, which is a difference between two fingerprinting runs rather than a model change and is handled by [capability abstention](#capability-abstention).

!!! note "Geometry change is shape/placement, not centroid drift"
    The engine detects geometry change through the mesh hash, not by measuring
    how far an element's bounding-box centre moved. Content-keyed matching can
    additionally report *how far* a matched element travelled, but only from an
    optional bounding box the caller supplies alongside the hashes - see
    [Content-keyed matching](#content-keyed-matching-unreliable-globalids).

## Content-keyed matching (unreliable GlobalIds)

A model re-exported from scratch by another tool gets entirely new GlobalIds, so the key-based match above reports every element as deleted-and-added even when nothing substantive changed. Pass `matchUnpairedByContent: true` to run a second pass, after the normal key-based pass, that re-examines the entities that came out `added`/`deleted` and pairs them by content where the pairing is unambiguous:

```ts
import { diffModels } from '@ifc-lite/diff';

const diff = diffModels(baseFingerprints, headFingerprints, {
  matchUnpairedByContent: true,
});

for (const match of diff.contentMatches ?? []) {
  switch (match.kind) {
    case 'renamed':
      // One entity per side, or a group of N identical ones.
      console.log('renamed', match.base.map((entity) => entity.key));
      break;
    case 'moved':
    case 'reshaped':
      console.log(match.kind, match.base[0].key, '->', match.head[0].key, match.distance);
      break;
    default:
      console.log(match.kind, 'group:', match.base.length, 'base,', match.head.length, 'head');
  }
}
```

### How a bucket is refined

Unpaired entities are bucketed by (`ifcType`, `dataHash`). Geometry is deliberately **not** part of that key: an element that genuinely moved would then land in a different bucket from its own previous revision and could never be paired at all, so every real move would revert to add+delete noise. Instead each bucket is refined from the inside, which matters because a real model is mostly *repeated* components - three data-identical doors at three different places share one bucket.

1. **World geometry hash.** Entities carrying a `geometryHash` are sub-bucketed by it. One per side, or the same count `N` on both sides, retires as a `renamed` match. `undefined` hashes are excluded: `undefined` agreeing with `undefined` is vacuous, not evidence. Uneven sub-buckets retire nothing and fall through to the next steps.
2. **The 1:1 leftover.** One base and one head left in the bucket pair as `renamed`, `moved`, or `reshaped`.
3. **The N:M leftover.** With an `aabb` on every remaining candidate, they are paired by *iterated mutual nearest neighbour*: a base and a head pair only when each is the other's unique nearest and they are no further apart than `maxMoveDistance`. Retiring a confident pair can disambiguate its neighbours, so this repeats to a fixpoint. The collision checks below are part of that pairing test rather than a filter over its result: a pair they reject leaves both candidates in the pool, so the following rounds pair the rest of the group against the real candidate set instead of one the rejected pair had already been removed from. Whatever is still unpaired is reported as a group.

Mutual nearest neighbour is used rather than greedy nearest-centroid (order-dependent, commits to bad chains) or optimal assignment (minimises *total* distance, so it pairs everything it is given, including elements that genuinely appeared). It abstains by construction: a symmetric layout of identical elements that all moved has no unique nearest neighbour anywhere, and "ambiguous" is the correct answer there. Groups larger than 128 per side skip this step and report as ambiguous.

### Match kinds

- **`renamed`** - data hash *and* world geometry hash agree; only the key (GlobalId) changed. The `added`/`deleted` entries are removed from `entries`/`byKey`/`counts` in favour of this record. Under `scope: 'data'` geometry is excluded from the comparison, so every 1:1 match is reported as `renamed`. A `renamed` match holds one entity per side, except for a group of `N` per side that agreed on both hashes - there every bijection is identical in every field the engine can see, so the members are reported as a set rather than as a fabricated pairing.
- **`moved`** - data hash agrees, geometry hash differs, and the bounding boxes are the same size while their centres are further apart than `moveTolerance`. Also what a geometry-hash difference reports when no bounding box is available, since nothing can then tell a move from a reshape. Retiring.
- **`reshaped`** - data hash agrees, geometry hash differs, and the bounding boxes differ in size beyond `reshapeTolerance` - or agree entirely, which is what a re-tessellation looks like. An axis-aligned box genuinely cannot separate a re-tessellation from a reshape confined to the interior, and this kind does not pretend it can. Retiring.
- **`duplicated`** - one base entity's content matches several head entities.
- **`deduplicated`** - several base entities' content matches one head entity.
- **`ambiguous`** - several candidates remain on both sides with no principled pairing: duplication could not be told from deduplication, positions were too symmetric for a unique nearest neighbour, or the only candidates were further apart than `maxMoveDistance`.

For `duplicated`/`deduplicated`/`ambiguous` the engine does not guess: the original `added`/`deleted` entries stay in `entries` untouched, and `match.base`/`match.head` list every candidate on each side for the caller to resolve.

### Bounding boxes and tolerances

`EntityFingerprint.aabb` is optional. Supply it and the pass can separate a move from a reshape, report the displacement, and pair repeated components by position. Leave it out and a 1:1 leftover still pairs - as `renamed` when the geometry hashes agree, and as a bare `moved` with no `distance` when they differ, since nothing is then available to tell a move from a reshape - while a group is reported as `ambiguous`. Both revisions must express the box in the **same world frame and units** - the same contract the geometry hash already carries:

```ts
import type { EntityFingerprint } from '@ifc-lite/diff';

const fingerprint: EntityFingerprint<number> = {
  key: 'globalId',
  ifcType: 'IfcDoor',
  dataHash: 'a1b2c3d4e5f60718',
  geometryHash: 1234567890n,
  aabb: { min: [0, 0, 0], max: [0.9, 0.2, 2.1] },
  ref: 42,
};
```

| Option | Default | What it controls |
| --- | --- | --- |
| `moveTolerance` | `2e-3` | Centre displacement below which a pair counts as not moved; `distance` is reported as `0`. |
| `reshapeTolerance` | `1e-3` | Per-axis size change above which a pair is `reshaped` rather than `moved`. |
| `maxMoveDistance` | `10` | Furthest apart two same-content entities may be and still pair in the **N:M positional stage** (step 3 above). |

The two tolerance defaults are lifted from `MOVE_EPS`/`RESHAPE_EPS` in the viewer's `describeChange.ts`, which encode issue #1197 - a phantom "moved 1.09 m" on a wall that never moved. The engine and the UI draw the move/reshape line in the same place on purpose. `moveTolerance` and `reshapeTolerance` apply wherever a pair is classified.

`maxMoveDistance` does **not**. It is a pairing cap for the mutual-nearest-neighbour stage only, in the caller's units, so `10` is a building-scale relocation for a metre-scale model. Where that stage is doing the pairing, two candidates further apart than the cap are never each other's accepted nearest and stay in the `ambiguous` group rather than being asserted to be the same element. A 1:1 leftover (step 2) is a different situation: there is exactly one candidate on each side of the bucket, nothing to disambiguate, and the pair is classified as `moved` however far it travelled. Set the cap to bound *positional guessing among repeated components*, not to bound how far the engine will believe an element moved.

### Capability abstention

If one revision was fingerprinted by a build that produces geometry hashes and the other by a build that does not, every one-sided `undefined` would read as "the geometry differs" and the whole model would report as changed. When a whole side carries no geometry hashes at all while the other does, **neither** pass uses geometry to classify anything: the key-based pass reports matched entities as `unchanged` (or `modified` on data alone, never with `'geometry'` in `changeKinds`), and the content pass reports matches as `renamed`, as if `scope: 'data'` had been selected. That is a capability difference between two fingerprinting runs, not a model change.

Only a *whole side* triggers it. If any participating entity on each side carries a hash, both sides are doing geometry hashing and one entity's one-sided `undefined` is a real change - geometry added or removed - which is still reported. `excludeTypes` is applied first, so an entity dropped from the comparison does not count as evidence that its side carries hashes.

The cost, stated plainly: a base revision that genuinely carries no geometry at all, compared against a head that added geometry to everything, is indistinguishable from a capability difference and reports as `unchanged`. That case is rare and recoverable (the fingerprints are the caller's own); the false positive it prevents - two possibly identical revisions reading as a wholly changed model - is neither.

### Hash collisions

`dataHash` is a 64-bit FNV-1a value. It was 32 bits until issue #1962: at that width collisions between plausible IFC content were findable by enumeration, and the package's tests pinned three real ones. 64 bits makes that class of collision vastly less likely, but it does not remove it and no finite hash could, and FNV-1a is a drift-catching hash rather than a cryptographic digest; the exposure grows with the square of the number of distinct fingerprints compared, and a from-scratch re-export leaves the whole model unpaired, which is the worst case. Every path that retires entries (a geometry-hash sub-bucket, a 1:1 leftover, a mutual-nearest-neighbour pair) destroys a real `added` and a real `deleted` if the data hash collided, so all of them apply the same two checks, neither of which can reject a genuine match:

- entities are bucketed by `ifcType` as well as `dataHash`. `buildDataFingerprint` already hashes `ifcType`, so identical content always agrees on it; a disagreement proves a collision.
- when both sides carry `components` (from `buildComponentFingerprints`), every sub-hash must agree. This holds only because the sub-hashes are computed over exactly the projection `buildDataFingerprint` hashes, GlobalId-free `type-assignment` included. A sub-hash that saw something `dataHash` does not would stop being a collision guard and start being a filter: it would reject genuine re-export matches, which is the opposite of what this pass is for.

Neither makes the pass collision-proof, and widening did not change which collisions the second check can see. FNV-1a's per-character update is a bijection on its state at any width, so for two entities differing only inside `attr:core` — a different `Name`, everything else equal — a `dataHash` collision *implies* an `attr:core` collision, and the component check cannot see it. It bites when the differing content sits in a pset or qset slice, whose sub-hash is computed over an unrelated string. That structural limit is unchanged; only the likelihood of hitting it dropped.

**Supply `components` if you enable this option.** The second check is only active when both revisions carry them, so how much protection you get depends on your adapter:

| what the adapter supplies | collisions caught | collisions still retired as a false match |
| --- | --- | --- |
| `dataHash` only | different `ifcType` | any collision within one `ifcType` |
| `dataHash` + `components` | different `ifcType`; differing pset/qset content | collisions confined to `attr:core` (name, description, object/predefined type) |

`buildComponentFingerprints` takes the same `DataFingerprintInput` you already pass to `buildDataFingerprint`, so populating it is one extra call per entity. No finite hash eliminates the `attr:core` row: a wider hash lowers the probability of an accidental collision, and a cryptographic one additionally makes a deliberate collision hard to construct, but neither is a guarantee. Treat it as a residual rather than a bug.

Ambiguous groups retire nothing, so a collision landing in one costs the caller an extra candidate to inspect rather than a lost entry.

The residual concentrates in the **1:1 leftover**. Every other retiring path has corroboration beyond the data hash — an agreeing world geometry hash, or a mutual-nearest-neighbour agreement within the move cap — while the 1:1 leftover rests on the data hash, `ifcType`, and `components` alone. That is where a false pair would come from.

Split and Merged (a *partial* geometric overlap between one entity and several others) are not implemented — they need a geometric-similarity threshold and a partial-overlap policy with no single correct answer.

`matchUnpairedByContent` defaults to `false`; existing callers of `diffModels` are unaffected. When you do enable it, populate `EntityFingerprint.components` as well — see [Hash collisions](#hash-collisions) for what that buys you.

### Type exclusion

Pass `excludeTypes` to drop classes from the comparison entirely, useful for connective entities like `IfcOpeningElement` that are noise, not meaningful change:

```ts
const diff = diffModels(base, head, { excludeTypes: ['IfcOpeningElement'] });
```

An entity is dropped if its IFC type matches in **either** revision, so a cross-version re-class (for example `IfcWall` becoming `IfcWallStandardCase` with `IfcWall` excluded) can never leak the entity back as a phantom add or delete. Matching is case-insensitive and trims whitespace, so a hand-typed `ifcopeningelement` still matches. The `ModelDiff.excludedTypes` field echoes back exactly what was ignored, normalized, for report provenance.

## Identity maps

Content-keyed matching answers "these two entities look like the same element" for one comparison and then forgets it. An **identity map** is the durable form of that answer: `{ base, here, reason }` triples that a later diff replays as key aliases, so a re-GUIDed element is matched by key and never reaches the content pass again. It is the same vocabulary a published layer carries in its provenance manifest `identity_map` (`docs/architecture/layer-prs/03-provenance.md` §3.1), so an entry derived here can be written into a layer without translation.

### Producing a map

`identityMapFromContentMatches` turns a diff's content matches into claims:

```ts
import { diffModels, identityMapFromContentMatches } from '@ifc-lite/diff';

const diff = diffModels(baseFingerprints, headFingerprints, { matchUnpairedByContent: true });
const claims = identityMapFromContentMatches(diff.contentMatches);
// [{ base: 'oldGlobalId', here: 'newGlobalId', reason: 'content-match:renamed' }, ...]
```

It only mints a claim from a match the engine **committed to**: a one-to-one `renamed`, `moved`, or `reshaped`. Everything else is refused, for one reason — a claim derived from an abstention is a fabrication:

- `ambiguous`, `duplicated`, and `deduplicated` are the engine saying it could not tell. They retire nothing, and identity is not a relation that survives being split or merged.
- an N:N `renamed` group agreed on both hashes `N` times over, which is exactly why the engine reports it as a set rather than a pairing: every bijection between the two sides is identical in every field the engine can see. Picking one — even deterministically — is a coin flip. It is tempting to call the choice harmless *because* the members are indistinguishable, but that is only true in this revision. A map is written down and replayed, and the pairing starts to matter in the first later revision where two members diverge or one of them carries a BCF topic, a review comment, or a cost line. At that point a coin flip silently swaps two elements' histories, and nothing records that it was a coin flip. The group stays in `contentMatches` so a UI can offer it to a human; the engine will not mint it unattended.

`reason` records the evidence (`content-match:renamed`, `content-match:moved`, `content-match:reshaped`) rather than a bare `"derived"`, which `docs/architecture/layer-prs/04-identity.md` §4.1(3) reserves for the content-derived identity *fallback* — a different claim.

### Consuming a map

`DiffOptions.keyAliases` is a `ReadonlyMap<string, string>` of **head key → base key**, applied as key normalization before the key-based pass indexes anything:

```ts
import { diffModels } from '@ifc-lite/diff';

const aliases = new Map([['newGlobalId', 'oldGlobalId']]);
const diff = diffModels(baseFingerprints, headFingerprints, {
  matchUnpairedByContent: true,
  keyAliases: aliases,
});
console.log(diff.appliedKeyAliases); // what actually took effect
```

Because the rename happens before indexing, an aliased pair is classified by the ordinary key pass and **never becomes a content-match candidate**. The resulting `DiffEntry.key` is the *base* key; the head entity's own key stays untouched on `entry.head.key`, so the alias changes what the diff calls the pair, not what either file says. Nothing rewrites GlobalIds in a file — that is a one-way door that falsifies the model, and `04-identity.md` is explicit that human-in-the-loop identity beats wrong automatic identity.

An alias is **ignored** — the head entity keeps its own key, exactly as if no map had been supplied — when:

| Situation | Why it is refused |
| --- | --- |
| the target key exists in no base entity | a stale map must not conjure a phantom keyed to something in neither file |
| another live head entity already holds the target key | that entity matches the base key on its own evidence; two head entities cannot be one base entity |
| two head entities claim the same base key | the same collision, arriving from the map instead of the model |

On a collision **the alias loses and every colliding entity stays unaliased**. A collision proves the map is wrong, and the map is the only thing that could have adjudicated; dropping an entity would be silent data loss, and picking a winner would be a guess with no evidence behind it. Refusing leaves both entities visible as add/delete, which is what the caller would have seen without the map and is a state a human can act on. `ModelDiff.appliedKeyAliases` echoes back what took effect, so "the map matched" is distinguishable from "the map was ignored".

Aliasing composes with `excludeTypes` and every `scope`: it decides only *which entities are the same entity*, while those decide what counts as a difference between two entities already known to be the same.

### The sidecar

For plain-file workflows there is no manifest to hold the map, so `@ifc-lite/diff` defines a small JSON sidecar that pins the content digest of **both** revisions the claims were verified against:

```json
{
  "format": "ifc-lite/identity-map",
  "version": 1,
  "base": { "hash": "sha256:...", "path": "model-v1.ifc" },
  "head": { "hash": "sha256:...", "path": "model-v2.ifc" },
  "created": "2026-08-02T00:00:00.000Z",
  "entries": [{ "base": "oldGlobalId", "here": "newGlobalId", "reason": "content-match:renamed" }]
}
```

The pinning is the point. A bare list of `old → new` pairs says nothing about which two files a human looked at when accepting it; replayed against a different pair it either silently does nothing or asserts an identity nobody reviewed. `identityMapSidecarMismatches` is how a consumer refuses that before applying a single alias:

```ts
import {
  createIdentityMapSidecar,
  identityMapSidecarMismatches,
  keyAliasesFromSidecar,
  parseIdentityMapSidecar,
  serializeIdentityMapSidecar,
} from '@ifc-lite/diff';

const text = serializeIdentityMapSidecar(
  createIdentityMapSidecar({
    base: { hash: 'sha256:aaa', path: 'model-v1.ifc' },
    head: { hash: 'sha256:bbb', path: 'model-v2.ifc' },
    entries: [{ base: 'oldGlobalId', here: 'newGlobalId', reason: 'content-match:renamed' }],
  }),
);

const sidecar = parseIdentityMapSidecar(text);
const problems = identityMapSidecarMismatches(sidecar, {
  base: { hash: 'sha256:aaa' },
  head: { hash: 'sha256:bbb' },
});
if (problems.length === 0) {
  const aliases = keyAliasesFromSidecar(sidecar); // here → base
  console.log(aliases.size);
}
```

Entries are sorted and de-duplicated on creation, so the same comparison writes the same bytes and a checked-in sidecar produces an empty git diff when nothing changed. `created` is optional and never stamped by default, for the same reason. `path` is informational and never compared — files move, and a comparison on the path would reject a valid map for the wrong reason while accepting an edited file at the same path.

`parseIdentityMapSidecar` refuses an unknown `version` or a malformed entry outright rather than applying the readable half, and it refuses one more thing on the same grounds: **two entries claiming different `base` identities for the same `here` key**. Both are about one head entity, and it cannot be two base entities — unlike the mirror-image conflict (two `here`s on one `base`), no pair of files can break the tie, because one of *those* head entities may simply have been deleted since. So the two conflicts are handled in different places: the contradictory document is rejected at parse, while two `here`s on one `base` are left for `resolveKeyAliases` to judge against the actual models. Applying the first of two contradictory claims would be exactly the arbitrary winner this design refuses everywhere else — and worse here, because a `--identity-in x --identity-out x` run writes the winner back out as if it had been reviewed. `keyAliasesFromSidecar` restates the rule for a hand-built object: a contradicted `here` yields no alias at all, and the rest of the map is unaffected.

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
| `--by-entity` | Compare every `IfcObjectDefinition` by GlobalId (added / removed / common) |
| `--by-content` | Run the `@ifc-lite/diff` engine with content-keyed matching |
| `--identity-out <file>` | Write the accepted matches to an identity-map sidecar (implies `--by-content`) |
| `--identity-in <file>` | Replay a sidecar's claims as key aliases (implies `--by-content`) |
| `--json` | JSON output |

Without `--by-entity`, the command reports the schema, entity count, entity-count delta, and the per-type differences (sorted by the size of the delta). With `--by-entity` it adds the count of GlobalIds added, removed, and common between the two files.

Those GlobalIds are the same set `--by-content` fingerprints: every `IfcObjectDefinition` in the file, decided from the inheritance chain of whichever bundled schema declares the class (IFC2X3, IFC4 or IFC4X3). Relationships and property sets are left out — a relationship's identity is its endpoints, and a property set's contents already travel with its owner — and so is anything that is not an `IfcRoot` at all. That last exclusion matters more than it sounds: the columnar parser fills its GlobalId column positionally, and slot 0 of a material, a surface style or a classification is a *Name*, so those entities used to be compared under their name and two of them sharing one collapsed into a single key.

### `--by-content` and the identity map

`--by-content` routes the same two files through the real engine, so a from-scratch re-export stops reading as "everything was deleted and re-added":

```bash
# Run 1: recognise the re-GUIDed elements and write the claims down.
ifc-lite diff model-v1.ifc model-v2.ifc --by-content --identity-out renames.json

# Review renames.json, then replay it. The re-GUID is no longer churn.
ifc-lite diff model-v1.ifc model-v2.ifc --identity-in renames.json
```

Two things to know about this path:

- **It compares data only.** The Node CLI has no geometry pipeline, so there is no world geometry hash and no bounding box; it passes `scope: 'data'`, which is the honest description of what it can see. Every unambiguous 1:1 content match therefore reports as `renamed`, and a `moved`/`reshaped` distinction is not available. For that, drive the engine with geometry hashes (or use the viewer's Compare mode).
- **`--identity-in` refuses a sidecar that was verified against different files**, because that is what pinning both digests is for. There is no override flag: the fix is to re-run the comparison that produced the claims, which is one command.

Passing `--identity-in` and `--identity-out` together rewrites the map with the claims that still held plus anything new, preserving each claim's original `reason`. Claims that no longer hold are dropped — the sidecar records what was verified against these two files, not what someone once hoped.

`--identity-out` is **reproducible**: the same two files and the same claims write byte-identical output, so a checked-in sidecar produces an empty git diff on a rerun. It writes no `created` timestamp of its own, and preserves an incoming one on a rewrite rather than refreshing it — the field dates the claims, not the last time a command was run.

!!! tip "CLI diff vs the diff engine"
    Plain `ifc-lite diff` answers "what changed at the type and identity level"
    quickly and without meshing. `--by-content` adds per-entity classification
    and content matching, still without geometry. For data-vs-geometry
    attribution, drive `@ifc-lite/diff` directly (or use the viewer's Compare
    mode below), supplying the data and geometry hashes.

## MCP usage

The [`model_diff` tool](mcp.md) takes the same `by_content` switch, so an agent gets the engine's answer instead of a GlobalId set intersection:

```json
{
  "name": "model_diff",
  "arguments": { "a": "v1", "b": "v2", "by_content": true }
}
```

Without it the tool reports per-type count deltas and `entityDiff` (GlobalIds added / removed / common) exactly as before. With it the result gains a `contentDiff`:

```json
{
  "contentDiff": {
    "scope": "data",
    "counts": { "added": 0, "modified": 0, "deleted": 0, "unchanged": 0 },
    "contentMatchCounts": { "renamed": 40 },
    "contentMatches": [
      {
        "kind": "renamed",
        "ifcType": "IfcSite",
        "base": ["23sFQGRy90RxVbRHD9iSE2"], "baseCount": 1, "baseTruncated": false,
        "head": ["1Pbuu0tu59NfhrTsztVBK1"], "headCount": 1, "headTruncated": false
      }
    ],
    "truncatedMatches": 0
  }
}
```

Five things to know about this path:

- **It is opt-in and defaults to off.** An `ambiguous` group has no honest scalar representation, so flipping the default would silently change what `counts` means for agent scripts that already call this tool.
- **It compares data only.** The MCP server has no geometry pipeline, so there is no world geometry hash and no bounding box; it passes `scope: 'data'` and reports it back in `contentDiff.scope`. Every unambiguous 1:1 content match therefore reports as `renamed`, and a `moved`/`reshaped` distinction is not available.
- **Groups are reported as groups.** `duplicated`, `deduplicated`, and `ambiguous` matches list every candidate on each side. Collapsing "we could not tell" into a number is the one thing an unsupervised agent cannot recover from.
- **Both caps report whole totals.** `max_matches` (default 200) bounds how many matches are listed and `truncatedMatches` says how many were left out; `max_group_members` (default 20) bounds how many GlobalIds each *side of one match* lists, with `baseCount` / `headCount` reporting the whole group size and `baseTruncated` / `headTruncated` saying whether the list was cut. Both are computed before the cap, and `contentMatchCounts` always reports whole per-kind totals — so no truncation can make a model look cleanly matched. Unresolved kinds are listed first, so the cap can never be what drops an ambiguous group.
- **Queued mutations count.** A `model_id` names a session, not a file: whatever `entity_create`, `entity_delete`, `entity_set_property` and `entity_set_attribute` have queued but not yet saved is folded into all three passes, and `contentDiff.pendingMutations` reports how many are in play on each side (the field is absent when neither model has any). Without this, an agent that had just edited a model and asked what changed was told nothing had.

The comparison covers every `IfcObjectDefinition` in the model, read through the inheritance chain of whichever bundled schema declares the class (IFC2X3, IFC4 or IFC4X3) rather than through the columnar parser's entity table — the same rule the CLI's `diff` uses, so non-product objects like `IfcTask` and `IfcActor` participate, IFC2X3-only and IFC4X3-only classes like `IfcMove` and `IfcRoad` are classified as what they are, and name-keyed resource entities like `IfcMaterial` stay out. See [what gets compared](cli.md#what-gets-compared) for the full rule.

!!! note "`model_diff` is the only overlay-aware read tool"
    The rest of the MCP read surface (`entity_get`, `entity_query`, …) answers
    from the model as parsed, and pending edits materialise on `export_ifc` /
    `model_save`. `model_diff` folds them in because "what is different" is its
    whole question and a pre-edit answer to it is not recoverable; use
    `mutation_diff` to see the queued edits themselves.

## Viewer Compare mode

The viewer's Compare UI is a consumer of this engine. It extracts an `EntityFingerprint` per entity from each loaded revision, the data hash from the store and the geometry hash from the WASM mesh pass, and feeds both sides to `diffModels`. The result colours the 3D scene by state (added, modified, deleted), lets you scope the comparison to data, geometry, or both, and drives an inspect panel that reports which signals changed for a picked entity. The persisted type-exclusion list flows straight into `excludeTypes`, so classes the team does not care about stay out of the change set.

For the full API, see the [`@ifc-lite/diff` README](https://github.com/LTplus-AG/ifc-lite/tree/main/packages/diff).
