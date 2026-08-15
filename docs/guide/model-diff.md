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
- `Tag`, **for type objects only** — the shipped adapters supply it for an `IfcTypeObject` subtype and never for an occurrence
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

!!! warning "`Tag` is hashed for type objects and not for occurrences"
    `DataFingerprintInput.tag` is hashed whenever you supply it. The adapters in
    this repo (CLI, MCP server, viewer) supply it **only** for an
    `IfcTypeObject` subtype, decided from the cross-schema inheritance chain,
    and your adapter should do the same.

    A type object carries no geometry hash, so its data fingerprint is the whole
    of the evidence a content match has about it — and same-named types are
    ordinary: the Duplex sample has eight `IfcFurnitureType` entities all named
    `800 mm`, identical in every other hashed attribute and separable only by
    `Tag`. Without it they share one content bucket and the engine correctly
    abstains on all eight.

    An occurrence is the opposite case. `IfcElement.Tag` is the authoring tool's
    own element id (Revit writes its `ElementId`), so two tools exporting one
    design disagree on it for every element — and `dataHash` is the content
    bucket key, so an occurrence whose `Tag` moved could not content-match at
    all. That is precisely the re-export scenario
    [content-keyed matching](#content-keyed-matching-unreliable-globalids)
    exists for, and where an occurrence carries a geometry hash that is what
    separates it anyway. `EntityFingerprint.geometryHash` is optional, so a
    geometry-less occurrence reaches content matching without one; the reason
    to keep its `Tag` out is that the value is exporter-specific, not that
    geometry is always there to fall back on.

    Re-tagging a type does **not** move the fingerprint of any element assigned
    to it: type assignments project the assigned type's name and IFC class only.

**Geometry hash** — an opaque fingerprint of the entity's mesh, supplied separately (a `bigint` from the WASM mesh pass, `MeshCollection.geometryHashValues`, or a string for callers that fingerprint geometry another way). Two entities are geometry-equal when both hashes are absent, or both are present and their normalized values match; one side missing means geometry was added or removed - unless one whole revision carries no hashes while the other does, which is a difference between two fingerprinting runs rather than a model change and is handled by [capability abstention](#capability-abstention).

**Enclosed volume** — optional, and read only by [split and merge detection](#split-and-merge-detection). `EntityFingerprint.volume` is the volume of the entity's geometry in the caller's units cubed (a `MeshCollection.geometryVolumeValues` entry, in cubic metres, for the WASM pass). Absent means **not proved** — never zero, and never "differs": the WASM producer emits a value only where the meshed geometry was provably a single closed, orientable, single-component solid, so an open `SurfaceModel`, a material-layered wall and any multi-item assembly all correctly report nothing rather than a plausible wrong number. Roughly a third of a real model carries no volume, by design. A `NaN`, zero or negative value is ignored exactly as if the field were absent; resolve your producer's absent-sentinel at its boundary rather than passing one through.

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

### Match tiers — the evidence behind a match

`match.kind` says *what the pass claims happened*. `match.tier` says *on what evidence*, naming which of the three refinement steps above produced the record:

- **`geometry-hash`** — step 1. The two sides landed in the same world-geometry-hash sub-bucket, `N` per side. The strongest evidence the pass has: data *and* world shape-and-position agree.
- **`residue-1-1`** — step 2. Exactly one base and one head were left in the bucket after step 1, and they agreed on `ifcType` and on every component sub-hash. This is the pass's only destructive path resting on the data hash alone, and the whole feature's false-positive budget concentrates here.
- **`positional`** — step 3. An N:M leftover paired by iterated mutual nearest neighbour on bounding-box centres, under `maxMoveDistance`. A geometric argument about where things sit, not about what they are.
- **`unresolved`** — nothing was retired. The record is a reported `duplicated`/`deduplicated`/`ambiguous` group.

The tier is **reported rather than left to be inferred**, because it cannot be inferred. A `renamed` whose two entities carry equal geometry hashes is reachable from step 1 *and* from step 3 — an uneven sub-bucket falls through to the residue, where the positional pass can still pair two entities that happen to share a hash — and those two records are not equally well evidenced. That ambiguity is worst on exactly the models where it matters: a real building is mostly repeated components.

Two uses. A consumer can weigh a match by its tier: auto-accepting `geometry-hash` while routing `residue-1-1` and `positional` to a human is a defensible policy, and one that was impossible to express before. And a validation harness can score the tiers separately — an aggregate precision number hides a tier that has stopped firing behind the tiers that still do, which is why `scripts/xmatch` stratifies by it.

```ts
import { diffModels } from '@ifc-lite/diff';

const tiered = diffModels(baseFingerprints, headFingerprints, {
  matchUnpairedByContent: true,
});

for (const match of tiered.contentMatches ?? []) {
  if (match.tier === 'geometry-hash') {
    // Data and world geometry agreed: accept without asking.
    console.log('accepted', match.base.map((entity) => entity.key));
  } else if (match.tier !== 'unresolved') {
    // Paired on the data hash alone, or on position. Worth a human.
    console.log('review', match.tier, match.kind, match.base[0].key);
  }
}
```

The field is optional (`ContentMatchTier | undefined`) so that a record from a producer predating it still typechecks; every record this engine emits carries one.

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
| `dataHash` + `components` | different `ifcType`; differing pset/qset content | collisions confined to `attr:core` (name, description, object/predefined type, and `tag` for type objects only) |

`buildComponentFingerprints` takes the same `DataFingerprintInput` you already pass to `buildDataFingerprint`, so populating it is one extra call per entity. No finite hash eliminates the `attr:core` row: a wider hash lowers the probability of an accidental collision, and a cryptographic one additionally makes a deliberate collision hard to construct, but neither is a guarantee. Treat it as a residual rather than a bug.

Ambiguous groups retire nothing, so a collision landing in one costs the caller an extra candidate to inspect rather than a lost entry.

The residual concentrates in the **1:1 leftover**. Every other retiring path has corroboration beyond the data hash — an agreeing world geometry hash, or a mutual-nearest-neighbour agreement within the move cap — while the 1:1 leftover rests on the data hash, `ifcType`, and `components` alone. That is where a false pair would come from.

Splits and merges — a *partial* geometric overlap between one entity and several others — are a separate, purely additive stage on this pass's residue: see [Split and merge detection](#split-and-merge-detection). They are not `ContentMatch`es and retire nothing.

`matchUnpairedByContent` defaults to `false`; existing callers of `diffModels` are unaffected. When you do enable it, populate `EntityFingerprint.components` as well — see [Hash collisions](#hash-collisions) for what that buys you.

### Type exclusion

Pass `excludeTypes` to drop classes from the comparison entirely, useful for connective entities like `IfcOpeningElement` that are noise, not meaningful change:

```ts
const diff = diffModels(base, head, { excludeTypes: ['IfcOpeningElement'] });
```

An entity is dropped if its IFC type matches in **either** revision, so a cross-version re-class (for example `IfcWall` becoming `IfcWallStandardCase` with `IfcWall` excluded) can never leak the entity back as a phantom add or delete. Matching is case-insensitive and trims whitespace, so a hand-typed `ifcopeningelement` still matches. The `ModelDiff.excludedTypes` field echoes back exactly what was ignored, normalized, for report provenance.

## Split and merge detection

One wall becomes three; three panels become one slab. Neither is a rename, a move or a reshape, so content matching leaves all four elements sitting in the residue as unrelated adds and deletes. `detectSplitMerge` looks for exactly that shape and reports what it finds on `ModelDiff.splitMerges`.

```ts
const diff = diffModels(base, head, {
  matchUnpairedByContent: true,
  detectSplitMerge: true,
});

for (const claim of diff.splitMerges ?? []) {
  console.log(claim.kind, claim.confidence, claim.whole.key, claim.pieces.length);
}
```

Three things to know before anything else:

- **It is a claim generator, not a decision.** A claim never retires a `DiffEntry` and never touches `counts` — every participant is still reported as the `added`/`deleted` it is. A split binds `k + 1` entities on one evidence chain, so a single wrong claim would delete `k + 1` real changes. A UI groups the underlying add/deletes under the claim; the engine does not remove them.
- **It runs on the residue, after content matching.** That ordering is load-bearing. Renames and moves have to be retired first, or a re-GUIDed wall plus one genuinely-new fixture inside its box fakes a volume-conserving "split" out of two things that were never related. `detectSplitMerge` is therefore only effective together with `matchUnpairedByContent`.
- **It has no non-geometric evidence channel.** It inherits the same abstentions as everything else geometric: under `scope: 'data'`, or when one revision carries geometry hashes and the other carries none, it reports nothing rather than guessing from data alone. Abstaining leaves `splitMerges` **absent**, not empty — presence records that the stage ran, emptiness records that it ran and found nothing.

Both directions always run. A `split` claim's `whole` is the base entity; a `merge` claim's `whole` is the head entity. Everything downstream reads `whole` and `pieces` and never has to know which way round the claim was found.

### The evidence profiles

`confidence` names what the claim rests on. It is three named profiles rather than a score, because the difference between them is a difference in *kind* of evidence, and averaging kinds into one number hides which one was missing.

| `confidence` | evidence |
|---|---|
| `verified` | the pieces sit inside the whole's own extent, every participant carried a `volume`, and the volumes sum to the whole's within `splitVolumeTolerance` |
| `extent` | the pieces sit inside the whole's extent and their boxes cover it on all three axes; a volume was missing somewhere and nothing was ever refuted |
| `displaced` | the pieces moved out of the whole's old extent — complete volumes within tolerance, congruent sorted extents, and a pairing unique in both directions |

`verified` and `displaced` carry `wholeVolume`, `piecesVolume` and a signed `volumeResidual`; `extent` carries none of them, because a partial sum reported as `piecesVolume` would read as the pieces' volume, which it is not.

### How volume is used

`EntityFingerprint.volume` is sparse by design — the producer emits one only where the meshed geometry was provably a single closed orientable solid, so roughly a third of a real model's elements carry none. The engine uses it **asymmetrically**, and that is what makes a sparse field useful:

- as **proof** it requires completeness. The whole and every single piece must carry a volume, because a sum missing a term is not a sum.
- as **refutation** it works partially. If the volumes already known overrun the whole beyond tolerance, no unknown can bring the total back down, and the claim is dead regardless of what cannot be seen.

**A failed volume test is a refutation, not a reason to try weaker evidence.** A candidate whose volumes are all known and miss the band gets no claim at all, even where the boxes would have covered the extent perfectly. The `extent` tier exists for the *absence* of evidence, never as a second chance after evidence came back negative.

Subsets are refused. The engine tests the full containment set or the full cluster, never an enumeration of its subsets — and the tolerance is exactly why. A tolerance widens the target band, so on a set of any size several different subsets qualify, and a non-unique answer is an abstention in this engine.

There is **one bounded exception**, because the common pollution in a real model is a single unrelated same-class element inside the parent's box. If a complete set overshoots by `r` and **exactly one** piece's own volume is `r` within tolerance, that piece is excluded and the rest is claimed; the excluded entity is reported on `claim.excluded` rather than silently dropped. That is solving for a unique explanation, not searching for a qualifying subset: it abstains when zero or two or more pieces explain `r`, and it is capped at one exclusion.

### Conflicts between claims

An added element can legitimately be both a split-piece of one whole and the merge-whole over several others, so every candidate claim from both directions is settled in one global pass. Claims are ordered by evidence — confidence, then how much of the residue the claim explains, then how closely the volumes agreed — and accepted greedily while every entity they bind is unclaimed.

A conflict decided **only** by the final lexicographic tiebreak drops **both** claims. The tiebreak exists to make the ordering reproducible on any machine; it does not adjudicate. Two claims the engine cannot tell apart are an abstention.

No claim ever becomes an identity-map entry, in either direction. Identity is not a relation that survives being split.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `detectSplitMerge` | `false` | Enable the stage. Effective only with `matchUnpairedByContent`. |
| `splitVolumeTolerance` | `0.03` | Relative volume agreement required, measured against the **whole**. |
| `splitPaddingMin` | `0.05` | Absolute floor of the containment/coverage slack, caller's units. |
| `splitPaddingRatio` | `0.01` | Fraction of the container's box diagonal used as slack, floored by the above. |
| `maxSplitPieces` | `256` | Performance bail, never a semantic rule. Must be a whole number of at least 2; anything else falls back to the default. |

The padding actually applied is `max(splitPaddingMin, splitPaddingRatio * containerBoxDiagonal)`, and it is always the *container's* — the base element of a split, the head element of a merge.

3% is a site number, not a float-error number: a real construction split loses material to joints, couplings and grout, and 1% refused splits that had plainly happened. `maxSplitPieces` is a cap for cost only — a precast slab field really is dozens of panels, and there is no piece count at which a split stops being a split. A candidate over the cap is dropped rather than truncated, because the first 256 of 400 panels is a claim nobody made.

Every option is coerced rather than validated, because `diffModels` has no error channel for its options: a non-finite or negative value is replaced by the documented default instead of poisoning every comparison. `maxSplitPieces` additionally has to be a whole number of at least 2 — a split into fewer than two pieces is not a split, so `0` or `1` is an unachievable cap rather than a tight one, and honouring it literally would make the stage report nothing with no error anywhere. It falls back to the default; a fractional value at or above 2 is floored. The fallback is the permissive direction on purpose, and only because of what the knob is: a cap resolving higher than asked can cost time, never correctness, while one resolving to nothing gives a wrong answer.

### What it cannot see

Stated plainly, because each of these is a decision rather than a bug:

- **Splits across classes are invisible.** Candidates are generated per `ifcType`, so an `IfcWall` becoming three `IfcWallStandardCase`s is not seen.
- **Two or more same-class interlopers inside the container are unrepairable.** With two of them the overshoot is their sum, and no single piece explains a sum. The one-exclusion cap is deliberate: allowing two puts the combinatorics, and the non-uniqueness the design refuses, straight back.
- **`extent` fires on a redesign in place.** Three new walls filling the footprint of one demolished wall look exactly like a split when no volume is available. It also fires on a perimeter of pieces enclosing an unfilled middle — covering all three axes is not the same as filling the interior, which is why the profile is named for coverage rather than for volume.
- **`displaced` cannot separate two congruent clusters in a repetitive building.** An identical slab field deleted on floor 3 and added on floor 5 has no distinguishing signature, and the pass abstains rather than pairing them.
- **A moved split under a rotation that is not a multiple of 90° is missed.** Sorted extents survive an axis permutation and nothing else; an arbitrary rotation changes the axis-aligned extents themselves.
- **A real split that changed more than `splitVolumeTolerance` of its material, while carrying full volume data, is refused.** That is the direct cost of gating on volume rather than scoring with it.

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

The viewer's Compare UI is a consumer of this engine. It extracts an `EntityFingerprint` per entity from each loaded revision — the data hash and the per-component sub-hashes from the store, the geometry hash from the WASM mesh pass — and feeds both sides to `diffModels`. The result colours the 3D scene by state (added, modified, deleted), lets you scope the comparison to data, geometry, or both, and drives an inspect panel that reports which signals changed for a picked entity. The persisted type-exclusion list flows straight into `excludeTypes`, so classes the team does not care about stay out of the change set.

### Content matching in the viewer

Compare mode runs `matchUnpairedByContent` **on by default**, and the panel has a *Match re-exported elements by content* checkbox to turn it off. The preference persists across files and sessions, like the ignored-classes list. Toggling it re-runs the diff from the fingerprints already extracted, so it is instant — no re-extraction.

Because both sides carry `components`, the viewer sits in the stronger row of the [collision table](#hash-collisions): a colliding data hash is additionally rejected when the pset/qset content disagrees.

The viewer supplies the `aabb` too, so the positional tiers are live: a 1:1 pair whose geometry hash differs is separated into `moved` (same extent, shifted centre) or `reshaped` (different extent), with the displacement reported in metres, and a group of same-content candidates is paired by iterated mutual nearest neighbour instead of being handed back as `ambiguous`.

The box comes from the same WASM mesh pass as the geometry hash (`MeshCollection.geometryAabbValues` → `MeshData.geometryAabb`), which matters for the frame contract above: it is **absolute world in the renderer's Y-up frame**, with the file's RTC offset and the per-element local-frame `origin` already folded in on the Rust side. Two revisions that chose different RTC offsets therefore report the same box, which is exactly what makes the comparison meaningful. Do not substitute a box folded from `MeshData.positions` — those are RTC- and origin-relative, and an element that moved would report as stationary.

Entities that only ever appear as GPU instances never reach the flat mesh array, so their boxes ride the same instanced side-channel as their hashes and are folded in by the fingerprint builder. That is deliberate rather than incidental: an element is instanced *because* it is one of many identical copies, which is precisely the population the mutual-nearest pass exists to pair.

Two cases still fall back to the engine's bare `moved`: a model restored from the viewer's geometry cache (the cache round-trips meshes, not fingerprints, so neither hash nor box survives it — Compare warns about this already), and a WASM build predating the getter.

What you see when a match is found:

| where | retiring match (`renamed` / `moved` / `reshaped`) | unresolved group (`duplicated` / `deduplicated` / `ambiguous`) |
| --- | --- | --- |
| 3D | the A copy is hidden, the B copy is drawn blue in the match channel | untouched: the entities keep their green/red add and delete colours |
| results list | a **Matched** group; clicking a row selects the surviving B copies | a **Needs review** group; clicking a row selects every candidate on both sides. The same entities are still listed under Added / Deleted |
| counts | a **Matched** badge next to Added / Deleted, which are lower *because* of it | counted as added/deleted, as they are |
| report (CSV/JSON) | one row per B element, `Change` = `Renamed` / `Moved` / `Reshaped`, with the counterpart's GlobalId in `MatchedGlobalId` when the match is exactly 1:1 | the existing add/delete rows gain the group kind in the `Match` column — no row is duplicated |

The report's `counts` gained `matched` and `needsReview` for the same reason the badge exists: a retiring match lowers `added` and `deleted`, and a reader who cannot see why would take the lower numbers at face value. `Match` and `MatchedGlobalId` are appended after `Model`, so a consumer reading the first six CSV columns positionally is unaffected.

For the full API, see the [`@ifc-lite/diff` README](https://github.com/LTplus-AG/ifc-lite/tree/main/packages/diff).
