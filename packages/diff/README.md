# @ifc-lite/diff

Headless model-diff engine for IFC-Lite. Classifies entities across two
revisions as **added / modified / deleted / unchanged**, with separable
**data vs geometry** scope — the engine behind the viewer's "compare two
versions" mode.

The package is **pure and store-agnostic**: it never touches a parser, a WASM
module, or a renderer. Adapters (the CLI, the viewer) extract a fingerprint per
entity and hand them over; the engine matches by key and classifies.

## Installation

```bash
npm install @ifc-lite/diff
```

## Usage

```ts
import {
  diffModels,
  buildDataFingerprint,
  identityMapFromContentMatches,
  type EntityFingerprint,
} from '@ifc-lite/diff';

// One fingerprint per entity, per model. `key` is the stable cross-revision
// identity (the IFC GlobalId). `dataHash` comes from buildDataFingerprint;
// `geometryHash` comes from the WASM mesh pass (MeshCollection.geometryHashValues,
// a BigUint64Array → bigint). `ref` is yours to use downstream (e.g. an express id).
const base: EntityFingerprint<number>[] = extractFingerprints(baseModel);
const head: EntityFingerprint<number>[] = extractFingerprints(headModel);

const diff = diffModels(base, head, { scope: 'both' }); // 'data' | 'geometry' | 'both'

diff.counts;            // { added, modified, deleted, unchanged }
diff.byKey.get(gid);    // O(1) lookup for picking — { state, changeKinds, base?, head? }
```

### Scope — what counts as a change

| `scope`      | Flags a `modified` when…                                    |
| ------------ | ----------------------------------------------------------- |
| `'data'`     | attributes / property sets / quantity sets / IFC type differ |
| `'geometry'` | the geometry fingerprint differs                             |
| `'both'`     | either (default)                                             |

A `modified` entry's `changeKinds` (`'data'` / `'geometry'`) records *why* — handy
for an inspect panel even though the colour is driven by `state`.

### Excluding classes - the blacklist

Some IFC classes are noise in a comparison: an `IfcOpeningElement` is only the
connective void between a wall and a window, so when the window is removed the
opening's deletion is not a meaningful change on its own (issue #1470). Pass
`excludeTypes` to leave those classes out of the diff entirely - matched
entities are dropped from **both** revisions before classification, so they never
appear in `entries`, `byKey`, or `counts`:

```ts
const diff = diffModels(base, head, { excludeTypes: ['IfcOpeningElement'] });
diff.excludedTypes; // ['IFCOPENINGELEMENT'] - the applied blacklist, normalized
```

Matching is case-insensitive and trims whitespace; empty names are ignored.

### Split and merge detection

One wall becomes three; three panels become one slab. Neither is a rename, a
move or a reshape, so content matching leaves all four elements in the residue
as unrelated adds and deletes. `detectSplitMerge` looks for that shape on the
residue and reports what it finds on `ModelDiff.splitMerges`:

```ts
const diff = diffModels(base, head, {
  matchUnpairedByContent: true,
  detectSplitMerge: true,
});
for (const claim of diff.splitMerges ?? []) {
  claim.kind;        // 'split' | 'merge'
  claim.confidence;  // 'verified' | 'extent' | 'displaced'
  claim.whole;       // the single entity (base for a split, head for a merge)
  claim.pieces;      // the k >= 2 entities on the other side
}
```

**Purely additive**: a claim never retires a `DiffEntry` and never touches
`counts`, because one claim binding `k + 1` entities on a single evidence chain
must not be able to delete `k + 1` real changes. It also has no non-geometric
evidence channel, so it inherits the `scope: 'data'` and mixed-capability
abstentions and reports nothing under either.

`confidence` names the evidence rather than scoring it: `verified` is
containment plus complete volumes agreeing within `splitVolumeTolerance` (3% by
default — a real split loses material to joints); `extent` is containment plus
per-axis interval coverage, where a volume was missing and nothing was refuted;
`displaced` is a moved cluster matched by volume and congruent extents, unique
in both directions. A failed volume test is a **refutation**, never a reason to
fall back to the weaker tier. See
[the guide](https://ifclite.dev/docs/guide/model-diff/#split-and-merge-detection)
for the knobs and for what the pass deliberately cannot see.

### Identity maps — remembering an accepted match

Content-keyed matching (`matchUnpairedByContent`) recognises a re-GUIDed element
once and then forgets it. An **identity map** makes that answer durable, in the
same `{ base, here, reason }` vocabulary a published layer carries in its
provenance manifest:

```ts
const first = diffModels(base, head, { matchUnpairedByContent: true });
const claims = identityMapFromContentMatches(first.contentMatches);
// [{ base: 'oldGid', here: 'newGid', reason: 'content-match:renamed' }]

const aliases = new Map(claims.map((c) => [c.here, c.base]));
const second = diffModels(base, head, { matchUnpairedByContent: true, keyAliases: aliases });
second.appliedKeyAliases; // what actually took effect
```

Claims come only from matches the engine *committed to* — a 1:1 `renamed`,
`moved`, or `reshaped`. `ambiguous` / `duplicated` / `deduplicated` groups and
N:N `renamed` groups mint nothing: they are the engine saying it could not tell,
and a claim derived from an abstention is a fabrication.

`keyAliases` (head key → base key) is applied *before* the key pass indexes
anything, so an aliased pair is classified by key and never becomes a
content-match candidate. `DiffEntry.key` becomes the base key while the head
entity keeps its own key on `entry.head.key` — the alias renames the pair, not
the file. A stale or colliding alias is dropped, degrading to the un-aliased
result rather than throwing or fabricating an entry.

For plain-file workflows, `createIdentityMapSidecar` /
`serializeIdentityMapSidecar` / `parseIdentityMapSidecar` define a JSON sidecar
that pins the content digest of **both** revisions the claims were verified
against, and `identityMapSidecarMismatches` refuses one replayed against a
different pair. A document claiming two different `base` identities for one
`here` key is refused outright too — it is self-contradictory whatever the two
files say, and applying either claim would pick an arbitrary winner. See the
[Model Diff guide](https://ifclite.dev/docs/guide/model-diff/#identity-maps).

### Building a data fingerprint

`buildDataFingerprint` canonicalizes (sorts) property sets, quantity sets, and
type assignments, so collection ordering never produces a spurious diff. Feed it
a plain `DataFingerprintInput` extracted from your store:

```ts
const dataHash = buildDataFingerprint({
  ifcType, name, description, objectType, predefinedType,
  propertySets, quantitySets, typeAssignments,
});
```

An assigned type is identified by its **name and IFC class**, never by its
`GlobalId`: `IfcTypeObject` is an `IfcRoot`, so a from-scratch re-export
re-GUIDs it and hashing that would change the fingerprint of every typed
element for no substantive reason. `TypeAssignmentInput.globalId` is still
accepted and still useful for display; it just does not reach any hash. See
[the guide](https://ifclite.dev/docs/guide/model-diff/#what-participates-in-the-fingerprint)
for the discrimination that costs.

There is also an optional `tag`, hashed whenever you supply it. Supply it **only
for an `IfcTypeObject` subtype**, as the adapters in this repo do: a type object
has no geometry hash, so same-named types differing only in `Tag` are otherwise
inseparable, while an occurrence's `Tag` is the authoring tool's element id and
hashing it there would stop two exporters of one design from matching at all.

## Why geometry hashing lives in Rust/WASM

The geometry fingerprint is computed in `ifc_lite_geometry::geom_hash` and
exposed over the WASM boundary (`IfcAPI.setComputeGeometryHashes` →
`MeshCollection.geometryHashValues`). It is RTC-invariant (a file's origin-shift
never registers as a change) and tolerance-quantized. This package only
*consumes* those hashes, keeping it dependency-free and unit-testable.

## Docs

See the [ifc-lite docs](https://ifclite.dev/docs/) and the
[API Reference](https://ifclite.dev/docs/api/typescript/).

## License

MPL-2.0
