# Independent viewer input witness: source-only prototype for #6537

This is an instrumented observer foundation above #6790. This layer enables no
model-loading workflow and grants no timing
eligibility. Existing `captureIdentity`, its caller, all previous refusal bytes,
and production sources remain unchanged. Unknown cases refuse.

## Registration and cold boundary

Before the original file upload, serialize `discoverViewerInput` once and pass
its exact frozen function source to `installViewerInputWitness`. It discovers a
unique renderer-owning current React Fiber and its existing empty Scene. The
DOM fiber return chain only locates the FiberRoot container; a complete bounded
walk of that container's committed `current` child/sibling tree must find the
actual canvas host fiber. Its traversal-derived ancestor path authorizes props,
including legitimate shared bailout children whose return pointers are stale.
Fixed new caps are 65,536 committed-tree nodes and 200 depth, plus the existing
2,048 hooks per ancestor/65,536 total. Unknown shape, cycles or caps refuse.
The renderer is assigned before asynchronous `init` in `Viewport.tsx:713`; discovery
does not call `init`, await readiness, request a frame or change file options.
Missing renderer/current branch/empty Scene or a discovery cap refuses.

The installation payload also needs an independently reviewed, frozen subject
reference-immutability audit, bound to the literal subject head and audit
manifest SHA. The audit must be verified by the future controller; the callback
does not independently authenticate its own caller. No such runtime controller
or qualified payload is provided by this prototype.

The store subscription observes real `pendingInstancedShards` delivery objects,
including repeated delivery of the same buffer. The Scene wrapper sees actual
`addInstancedShard` inputs before ingestion. Template views must share exactly
one observed original ArrayBuffer. No IFC wire decoder is duplicated. Observation
has synchronous bounded bookkeeping, with no hashing, serialization or geometry
copy. Native receiver, arguments, result and exceptions pass through unchanged,
including after observer refusal. A source shard must be delivered and ingested
exactly once. Repeated/failed/unowned/late delivery refuses.

Initial explicit bounds: 10,000 deliveries, 10,000 ingestion calls, 256 MiB of
retained original source buffers. These are reference-retention bounds, not
physical-memory bounds. The capture separately uses the caller's original
digest/work bounds; snapshot allocation is checked before copying a buffer.
Scope is one fresh, visible primary model at the verified canonical offset/index
zero. Model UUIDs, device handles and epochs fence association/freshness only;
they are excluded from cross-arm semantic digests.

## Mandatory reference audit and its limits

* `packed-geometry-decoder.ts:19`: an ArrayBuffer payload returns by identity.
* `packed-instanced-decoder.ts:260`: template arrays are views of that buffer;
  occurrence transforms and color arrays are decoded copies.
* `useGeometryStreaming.ts:809`: decoding precedes canonical offset/level
  placement and Scene ingestion. The prototype permits only primary offset zero
  and no applied level offsets; neither modifies decoded occurrence input then.
* `instanced-render.ts:226`: preparation reads decoded templates/occurrences,
  computes separate matrices/anchors/packed output and does not modify input.
* `scene.ts:2986`: Scene retains template input views, creates separate packed
  instance records and does not mutate decoded transform/color objects. Canonical
  updates/removals, reset after delivery, suppression and release are refused.
* `useIfcLoader.ts:1764` retains original shard buffers for cache serialization.
  `packages/cache/src/writer.ts:144` invokes `writeInstancedShards`, whose section
  writer borrows a Uint8Array and passes it to `BufferWriter.writeBytes`; that
  writer copies into its own output. The full chain needs literal-subject pins.

Deferred references do not independently prove bytes as they existed at entry
if arbitrary code mutates them. This prototype relies on the exact reviewed
source restrictions above, plus revision and pointer guards. A literal-source
audit of both frozen subjects covers the delivery/decoder/preparation/cache chain;
it is conditional source evidence. Controller authentication, actual canonical
decoder/preparation controls now pass at the CPU API seam described below;
hosted runtime immutability remains UNQUALIFIED.
Unexpected updates after freeze or changed native wrapper/renderer/Scene/device/
model/store refuse. No attempt is made to replay editing operations.

## Three independent identities and expected owners

`captureViewerInputIdentity` runs after the existing timer/readiness boundary.
It retains the old full-produced CPU digest formula: all produced flat meshes,
including hidden types, plus every retained packed instance channel and geometry
hash/AABB/volume maps. No hidden produced channel is dropped. Its legacy digest
equivalence passes a functional control on a legacy-supported typed-array fixture.

The new viewport identity hashes the actual current renderer-owning Fiber's flat
input, complete decoded instance input, coordinate/section source frames and
visibility policy. Actual UUID mappings must independently prove single-primary
index zero. Effective view mode is explicitly source-derived, not claimed to be
an observed named React local. Current input is independently hashed. User hides,
isolation, ghost overlays, Types presentation, model placement and texture/text
appearance remain unsupported; type-visibility toggles are recorded unchanged.

Expected flat owners follow actual `Scene.addMeshData` input ownership:
nonempty per-vertex `entityIds` contributes every distinct contributor; otherwise
the representative `expressId`. Scene keys are never used as the expectation.
The proposal also compares complete per-owner flat piece multisets:
each actual viewport input contributes exactly once to every unique owner, and
duplicates retain their multiplicity. Expected pieces come only from that input;
actual pieces come from the private retained `Scene.meshDataMap` arrays. No
accessor is called that extracts contributors or materializes instances. Both
positions and every allowed raw shape/material field enter the comparison.

`expectedZeroPlacedMesh` is a separate, frozen expected-input oracle for the
literal BASE/CAND `ModelTranslations.placeMesh` contract at zero translation:
it shallow-copies each input, adds zero to origin (including absent origin),
the three matrix translation entries, and AABB minima/maxima. This intentionally
models the documented `+0` signed-zero behavior. Actual retained output is hashed
raw and never passed through this oracle. Other placement/schema is unsupported.
The primary namespace must already be stamped `modelIndex: 0`, as the actual
`geometryWithModelIndex` caller does before props reach the current viewport.
Empty canonical level-offset maps leave those inputs unchanged before Scene
ingestion. Streaming can split topology above 180,000 indices or 8 MiB of vertex
positions/normals; this proposal explicitly refuses those inputs, instead of
introducing a second topology decoder. Canonical split/input qualification for
that case remains pending. The old full-produced digest remains unchanged.

Expected instance owners and occurrence counts come from accepted independent
decoded inputs. Their template geometry multiplicities are checked against
retained output. Scene output still carries the complete packed transforms,
anchors, original colors, item IDs and finish bits into the full CPU digest.

The prototype supports only fully opaque (`alpha === 1`), finite, nonempty,
valid-template inputs. This is a conservative subset, not a duplicate of the
renderer's alpha cutoff. Other alpha values, empty/unreferenced templates,
malformed indices, fallback copied templates and unknown channels refuse.
All raw delivered IFNS bytes remain retained upstream until explicit disposal;
unsupported admission does not silently discard their source channels. It does
not grant a complete input hash on a refused capture.

Each raw IFNS delivery hash, size and ordered delivery record is retained as
auxiliary provenance, together with decoded shard field-presence flags and
counts. These partition-sensitive raw digests are not a cross-arm pass gate.
The independent decoded-ingestion identity binds each occurrence to its complete
template content and hashes the resulting multiset, retaining duplicates, all
origin/shape/transform/color/item/finish channels. Template table ordinals and
transport grouping are replaced by that verified content binding. Unknown
decoded fields refuse. Exact frozen decoder/encoder field coverage is required;
this does not grant coverage to unknown trailing wire fields silently skipped
by a permissive decoder. A post-timer envelope checker now permits only the
audited encoder forms v1/88 (word7=0), v2/92 and v3/100, exact total byte extent
and contiguous complete template pools. Unknown versions/strides/tails refuse.
This is coverage validation of native decoded inputs, not a replacement decoder.
Complete immutable-source/controller qualification remains pending.

All digests occur after timing. The fixed observer has nonzero overhead during
loading in both arms; results cannot be pooled with an uninstrumented cohort.
GPU completed pixels, full metadata and full authored appearance are not covered.

## Functional controls (current V7: 23 PASS; historical V5: 16 PASS)

The first guarded attempt refused before launching a child: disk availability
was below the unchanged 10 GiB starting floor. The original source freeze and
that resource refusal are retained outside the worktree. No threshold was changed.
After the root released its completed owned debug cache, an admitted attempt
passed 15 controls and failed one test's expected diagnostic: removal correctly
refused at the earlier retained-occurrence coverage check. Only that expectation
was corrected; the next admitted run passed all 16. Both raw runs are preserved.
That historical attempt performed no browser, canonical Scene/GPU qualification,
build or timing run.
The subsequent source-only increment adds seven controls for the retained-piece
gap found in review. A complete guarded run of the frozen V7 source passes all
23 controls with no failures or skips: missing same-owner piece, duplicate
piece, altered position/color/finish, actual empty filtered viewport, absent/
negative-zero placement, altered retained origin/matrix/AABB, and the streaming
index boundary (180,000 accepted; 180,003 explicitly unsupported).

A surgical inverse preserves all test registration and replaces only the
expected-versus-retained piece-map comparison with an expected self-comparison.
The four selected negative controls produce four genuine assertion failures,
not loading failures. Exact source restoration gives four passing controls.
Grouped corruption controls stop at their first failure in the inverse; the
normal run exercises every listed corruption within those groups. Frozen source
packets and both raw inverse/restoration runs are preserved outside the worktree.

The passing controls execute serialized callbacks without module closures,
observe transient store delivery, preserve native receiver/result/throw, roll
back failed installation, restore inherited descriptors, refuse missed/repeated/
late/capped ingestion, detect independent hidden-output and policy changes,
check merged contributor and instance ownership, compare one-versus-two shard
grouping, retain the exact legacy produced digest, reject stale alternate props,
and refuse unknown envelope versions and transparent input.

Seven additional canonical CPU controls pass through actual store delivery,
decoder, preparation, placement and Scene retention after an own fresh official
WASM build and plain forced root typecheck: 111 tasks executed, zero cached,
and 3,324 test sources audited. Only GPU buffer allocation/copy is mocked; this
is not mounted React ingestion or real GPU/model evidence. The original Rust
four-index wire goldens remain unchanged and refused by the strict triangle
identity; the positive triangle compatibility fixture is openly synthetic.

The broader prospective control plan below includes cases not yet executed:
every scalar-channel mutation, arbitrary mid-hash mutation, controller
authentication, and hosted runtime qualification.
It must not be read as a list of completed controls.

1. Execute serialized discovery/installation/capture functions in an isolated VM
   with a function-shaped Zustand store and a current renderer-owning Fiber.
   Incomplete/cyclic/capped discovery and stale alternate branches must refuse.
2. Use a subscription fixture that actually accumulates/delivers/drains buffers.
   Multiple shards, native receiver/result/throw and refusal-with-native-delegation
   are checked; missed delivery, repeated buffer, replacement and cleanup refuse.
3. Use real typed-array payloads and an independently interpreting Scene fixture;
   missing flat owner, merged contributor, instance owner or occurrence refuses.
   Verify representative IDs outside `entityIds` are not invented as contributors.
4. Mutate candidate-only current input/type policy and hidden produced raw bytes.
   The respective independent digest must change even if candidate scene matches.
5. Alter decoded transform/color/item/material, packed matrix/anchor/finish and
   template bytes separately. Cross-arm checks must reject each changed channel.
6. Exercise empty, transparent, invalid template, unknown wire/input channels,
   detached/replaced buffer, same-buffer repeated delivery, caps and late changes.
   Observer refusal must preserve native return/throw and exact descriptor cleanup.
7. Compare the new full-produced digest with actual legacy `captureIdentity` on
   an originally supported fixture; the expectation change must not rewrite it.
8. One shard versus two shards with identical complete logical input must have
   equal decoded-ingestion semantics despite differing auxiliary raw digests;
   dropped/duplicated/transformed occurrences must differ or refuse.
9. Test method replacement during cleanup, mid-hash state/input mutation and
   future controller audit-pin refusal. Real canonical decoder/preparation tests
   pass at the API seam; actual hosted browser input qualification remains
   mandatory afterward.

No full scan upgrades the previous 361-owner evidence. A future complete bounded
classification can explain every excluded ID prospectively; the existing raw
packet remains partial and refused.
