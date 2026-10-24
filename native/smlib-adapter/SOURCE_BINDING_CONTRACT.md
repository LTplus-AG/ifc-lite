<!-- SPDX-License-Identifier: MPL-2.0 -->
# Initial source construction correspondence (#7955)

This is unqualified, explicit opt-in infrastructure. It does not complete J5 or
release admission. Exact remains default. Existing public ABI v1 functions,
legacy sweep packets, and revision-local source-face stream 3 keep their meaning.

The native `SmlibWorker::require_source_faces` and corresponding internal browser
worker method make the common processing issuer bind format-1 requests to the
original source epoch/revision. The immutable request allocation remains in the
receipt. The existing owned processing source, decoder and lifecycle checks still
control acceptance; numeric source IDs or a decoded packet cannot issue authority.
A standalone caller can request numerical correspondence with
`RetainedRequest::with_source_contract`, but this does not authenticate an IFC
source or grant a processing/product receipt.

The production adapter constructs a dedicated context per independent source.
Each side role is attached to the actual `CreateFaceFromSurface` output at the
call for its encoded construction segment. Start/end caps use the actual
`CreatePlanarFacesWith3DCurves` outputs, requiring exactly one connected face per
cap. Birth/destruction generations and a bounded constructor observer survive
stitching and initial rational normalization. Complete inventory checks use face
sets only, never their enumeration order. An initial generic surface copy and
normalization use the same exact coefficient comparisons as the previous owner;
the existing normalization entry guard and numerical lineage guards are unchanged.
The new normalization entry requires a still-active private constructor receipt.

These roles are **construction features of the source solid**, not fabricated
`IfcFace` IDs, and not generated Boolean/clip interfaces. Segment ordinals refer
to the encoded source construction recipe (which may itself be a captured,
regularized profile). Authored face-based representations are not admitted by
this sweep path. A source representation needing authored face identity needs
its own direct face-constructor issuance.

Initial issuance transfers immediately to the lifetime ledger. Affine copies
use the existing map-checked copy and three-stage affine transition. Mesh roots
come from actual tessellation `GetOriginalFace` correspondence and immutable
ledger ancestors. They never come from a geometric match or a local face index.
Source-bound Boolean/clip/legacy rigid operations currently refuse before
mutation. Legacy numerical operations remain available without source binding;
refusal does not satisfy their outstanding lineage requirement.

## Private wire extension

Capability bit **256** advertises these packets; bit 128 stays reserved for the
unimplemented paired split. Framing and public C ABI versions remain 1. All
integers are little endian, with u64 values preserved as bytes/BigInt in JS.

- Opcode 21: session:u64, upload:u64, schema:u32=1, incarnation:u64,
  source_epoch:u64 (zero is valid), source_revision:u64, source_entity:u32.
  Consumes the existing complete format-1 upload and returns a normal handle.
  Its operation identity is the actual upload token, checked by both readers.
- Opcode 22: session:u64, object:handle. Returns schema:u32=1, current:handle,
  original_source:handle, incarnation:u64, epoch:u64, revision:u64, entity:u32,
  operation:u64, role_schema:u32=1, count:u32, then count rows of
  domain:u64, generation:u64, role:u32, ordinal:u32.
- Stream 5 through existing opcode 11: one u32 original-root row per triangle.
  It is unavailable on meshes without observed source correspondence.

Role 1 is swept construction segment `ordinal`; role 2 is the original start
cap; role 3 is the original end cap. Both cap ordinals are zero. The complete
inventory contains all segments in recipe order followed by the two caps; this
is issuance order, not final SDK enumeration order. A packet is at most 3,200
bytes, with at most 128 segments/130 roots. Readers require exact size, complete
roles, unique native roots, the captured request, current handle, original
source handle, incarnation, epoch, revision, entity, and initial operation.
Copies and meshes must preserve the entire original inventory byte-for-byte.
Final triangle correspondence must cover the complete source inventory.

There are at most 32 live native source domains, each with the existing bounded
ledger and a constructor limit of 1,024 face births/131,072 notifications. Native
and JS object registries retain only issued live objects. Rust inventory backing
is charged through the original resource scope; triangle backing is included in
mesh limits. Affine descendants share source ownership; releasing one object
never reseeds its descendants.

## Parent qualification

No build, SDK execution, Clippy or mutation run was performed in this child.
The pre-existing `UnsupportedGeometryChange` tessellation hold is unchanged.
The new CTest constructor lane is independent of tessellation. The full native
and actual Worker lanes intentionally require successful real execution and
consumed geometry; a refusal or skipped test is not positive evidence.

`source_binding_mutation_oracle.py` independently builds and restores four native
mutations. `scripts/retained-source-binding-oracle.py` independently runs two
shared Rust decoder mutations. CI invokes both and includes both outcomes in its
final required-result aggregation. Compiler failure, timeout, a non-green control
or an unrelated assertion does not count as semantic RED.

## Source receipt backing

The native product executor consumes an accounted affine final mesh, rather than
accepting a copy's inventory-only proof. The original caller limits and resource
context reach its mesh reader. Browser readers inspect bounded typed-array lengths
and admit live/copy bytes before deserialization, without an intervening await.
Triangle-root reservations follow the shared proof; mesh reservations follow the
mesh or construction completion. Inventory reservations also refund on final drop.
The source-review mutation lanes independently exercise native final consumption
and actual Worker admission/lifetime assertions. Their definitions are not
executed qualification, and they do not alter native numerical transition guards.
