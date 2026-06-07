# @ifc-lite/diff

Headless model-diff engine for IFC-Lite. Classifies entities across two
revisions as **added / modified / deleted / unchanged**, with separable
**data vs geometry** scope — the engine behind the viewer's "compare two
versions" mode.

The package is **pure and store-agnostic**: it never touches a parser, a WASM
module, or a renderer. Adapters (the CLI, the viewer) extract a fingerprint per
entity and hand them over; the engine matches by key and classifies.

## Usage

```ts
import { diffModels, buildDataFingerprint, type EntityFingerprint } from '@ifc-lite/diff';

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

## Why geometry hashing lives in Rust/WASM

The geometry fingerprint is computed in `ifc_lite_geometry::geom_hash` and
exposed over the WASM boundary (`IfcAPI.setComputeGeometryHashes` →
`MeshCollection.geometryHashValues`). It is RTC-invariant (a file's origin-shift
never registers as a change) and tolerance-quantized. This package only
*consumes* those hashes, keeping it dependency-free and unit-testable.

## License

MPL-2.0
