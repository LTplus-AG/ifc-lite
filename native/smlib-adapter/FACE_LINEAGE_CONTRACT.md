<!-- SPDX-License-Identifier: MPL-2.0 -->
# Native face provenance foundation (#7955)

**Qualification: UNRUN. Full J5 and release remain open.** This disabled native
foundation starts from the reviewed analytic-normal/source-winding base. It
selectively ports the corrected event-time mechanism from `4c90b7375835`;
it does not treat the original `9d5dc61e56` prototype as sufficient.

## Identity and ownership

`face_lineage::Ledger` owns immutable `(domain, sequence)` event identities and
root records. Actual constructor/destructor events delimit address lifetimes;
addresses locate only current bindings. Copy uses real `MergeBrep` forward and
reverse maps plus the actual `SM_NO_COPY` notifications. Split freezes its old
parent before updating reused bindings; merge retains both ancestors. Root
queries walk a bounded DAG iteratively and deduplicate root identities.

`OwnedBoundary` owns the SDK BRep and shares the ledger/continuous callback owner
with copies and tessellations. Its sole source bootstrap is a fixed native box
constructor with no foreign hooks and immediate complete-inventory admission.
There is no arbitrary-BRep adoption method on this owner. Generated plane
construction uses the separate fixed `GeneratedPlane` transaction: exact live
construction generation, operation/revision, complete boundary and retained
representation must agree before first root issuance. Generated roots cannot
be relabelled as source-boundary roots.

**These are native constructor/operation identities, not IFC identities.** The
private bootstrap's revision values are not public session/handle credentials.
No STEP entity, source-controller revision, mapped occurrence or IFC face has
been authenticated. `PersistentIfcFaces` remains undischarged. No caller can
submit these records as authority; no wire opcode/capability is added.

Tessellation correspondence is obtained from the SDK's actual
`SmPolyFace::GetOriginalFace()`, then follows the existing parent-polygon
triangulation correspondence. It never comes from array position, an old
address, coordinates, coplanarity or a closest triangle. The reviewed analytic
corner-normal/winding path is unchanged. Repeated tessellation must preserve
native face identities; its actual-SDK positive witness is **UNRUN**. An
unexpected callback/edit or failed exact source comparison fails the operation
and publishes no mesh. A mesh retains its private observation owner.

## Deliberate refusal boundary

The corrected prototype's numerical guards are retained. Unknown callbacks,
silent representation changes, unissued numerical edits, foreign generations,
callback replacement, missing inventory/history and observation gaps refuse.
The SDK ignores callback statuses, so latches are checked before acceptance.
A fixed rectangular split/delete-edge roundtrip has a restricted event plan,
exact source/output comparison and independent fixed area/volume assertions.
This is not general Boolean splitting or an interface-cap operation.

Generic affine, Boolean and clip histories have **not** been audited into this
owner. Its corresponding methods refuse *before* SDK work. The existing ABI
still performs its numerical operations and explicitly records unavailable
native provenance on every constructor/affine/Boolean/clip/tessellation output.
Its face-index stream remains revision-local. It is never retroactively adopted
as certified source history. This preserves the current disabled numerical
infrastructure without inventing a lineage capability or partial final product.

In particular, affine identity preservation is an open positive obligation:
this slice tests the refusal and unchanged inputs, not a fictitious positive.
General persistent identity across copy/split/merge is limited to the actual
map/event mechanisms and audited representation subset below. No general
retessellation, SDK mutation or IFC persistence claim follows from C++ types.

## Bounds and failure ownership

Default ledger limits: 8192 nodes, 32768 events, 1024 roots and 16 callback
frames. Admitted configurations cap nodes at 65536, events at 131072, frames at
64 and aggregate ledger allocation at 64 MiB. Ledger callback tables are preallocated. The subdivision receipt below also
uses bounded incident inventories and exact geometry snapshots during callbacks. Each exact
seal reserves two 1048576-word tables and an 8192-object worklist. The fixed
transition permits at most four simultaneous seals, 64 faces, 128 edges and
128 vertices. SDK-internal allocation is not claimed to be bounded by these
adapter budgets. Durable ancestry/event quotas do not refund on destruction.

Stage 1 read accounting (#7955/r13) keeps these durable limits unchanged.
Only observed non-face lifetimes inside the fixed tessellation frame use a
separate table, allocated before callbacks, with at most 65536 simultaneously
live entries. Destruction removes the exact retired generation and refunds one
slot; generations are monotonically issued from the same sequence and never
recycled. Tokens carry the existing constructor/origin/owner/operation fields,
but have no ancestry node and cannot answer root queries. Face births, copy
parents, roots and operation receipts keep the existing ancestry checks.

The independent live bound is chosen before validation: 4096 two-face splits
at 13 observed births each use 53248 slots, leaving 12288 for the copied input
and helpers. Higher-valence topology or a larger input can reach the live bound
sooner and must refuse. This is a resource contract, not a geometric guarantee.
The preallocated open-addressed table has 2*65536+1 slots; backward deletion
closes probe chains, so dead addresses do not consume the live budget. Its
bytes and the 1024-entry diagnostic trace are included in the 64 MiB ledger
ceiling. The table is reused only after successful checked retirement.

Read callbacks still run every existing receipt/authority check, but use a
bounded scratch trace, not the durable event journal. The read work budget is
2097152 callbacks: 4096*256 split notifications plus the same allowance for
copying, numerical helpers, polygon receipts and destruction. The 1024-entry
trace is diagnostic only and rejects expired test queries; overwriting it
cannot issue authority. Read storage is released only after SDK success,
complete receipts, retired temporaries, unchanged input and checked final
polygon rebinding. No per-read replacement for the event protocol is introduced.
Independent read limits may be reduced; admission caps live entries at 65536
and callbacks at 4194304, still subject to the aggregate allocation ceiling.

Preflight refusal performs no destructive operation and publishes nothing.
After uncertain SDK mutation, failure uses the existing terminal status-8
isolation path, abandons potentially unlinked allocations and requires module/
process disposal. This is publication rollback, **not** a per-object no-leak or
SDK rollback claim. Event-budget fault tests require no returned object and
status 8 on unrelated handles. Scope guards restore callback/context ownership.

Every owned instance method (including historical `ancestors` and unsupported
operations) checks the global terminal latch before accessing state, solid or
context. Terminal isolation takes precedence over argument/moved-from errors.
In a healthy isolation a moved-from receiver returns `INVALID_ARGUMENT`; the
moved-to owner remains usable. Destruction still abandons SDK objects after
taint. Separate process/module tests latch the real terminal state while the
owner ledger is healthy and require no new events, nodes or mesh publication;
there is no test reset or recovery path.

## Pinned SDK evidence

Inspected source revision: `c9c5979f04cea8c38213004d4f04df0dcfb40d05`.
Paths below are relative to that SDK, not copied/vendored source.

- `source/SMLib/src/SmFace.cpp`: constructor/destructor notifications at 78/94;
  event payload contract near 11868.
- `source/SMLib/src/SmObject.cpp:249`: user/system callback results are ignored.
- `source/SMLib/src/SmBrep.cpp:23350`: completed face copy notifications;
  `inc/SmCopyBrepMap.h`: maps are valid only for the unchanged topology pair.
- `source/SMLib/src/SmBrep.cpp`: face split notifications at 13427/15155;
  merge notifications include the survivor and removed face (e.g. 5975).
- Silent face UV-domain, trim-pointer and coefficient writes are real SDK
  routes. Exact representation checks detect changed terminal state, but cannot
  prove that an arbitrary hidden mutation never happened. Therefore foreign
  hooks and unaudited entrypoints cannot gain authority from equal snapshots.

The port includes the later initial-issuance, generated-owner transaction,
restricted numerical-read and terminal transition-target corrections. The
representation subset is generic topology, materialized unborrowed UV trims,
planes/generic B-spline surfaces and lines/generic B-spline curves in the pinned
OLD tolerance build. Other evaluator classes and missing trims refuse.

## Qualification and independent mutation oracles

`smlib_native_face_lineage_*` cases are invoked by the existing native and Emscripten
CTest jobs. It includes actual SDK generated construction, copies, fixed
split/merge ancestors, already-mated coplanar source/generated union, observed
address reuse, silent edits, unknown mutation, callback replacement, observation
gap and terminal budget failure. Alias witnesses have a fixed 128-allocation
bound and fail, rather than skip, if the allocator does not exhibit reuse.
The new owned witness checks two tessellations and explicit unaudited-operation
refusals. No numerical tolerances were relaxed: fixed split box volume 8 and
area 24 retain absolute 1e-8 assertions.

The existing CI workflow separately invokes `lineage_mutation_oracle.py` and
requires its result. Ten independent mutations cover split receipt identity,
merged receipt identity, mixed-root preservation, tessellation coverage,
unknown numerical mutation, event-budget enforcement, three owned terminal
entry guards and a bijective wrong-face permutation. The correspondence oracle
records actual source face vertices and root identity before copy/tessellation,
then checks every triangle against its claimed root's supporting rectangle on
both retessellations of the asymmetric box. It does not infer identity from
array order. Mixed-root postconditions are reported outside SDK uncertainty
catches; mismatches abandon operands and exit without further SDK operations.
Actual SDK failures remain terminal. Every case requires a
green control and the intended test assertion. Compile failure, crash, timeout
and incidental isolation taint never count as a kill. Existing six geometric,
six packet and three normal mutations are unchanged.

All compiled tests and mutation executions in this slice remain **UNRUN**;
parent qualification owns them. Source inspection and lightweight checks are
not SDK event coverage or a performance verdict.

## Release holds

Source-controller/IFC binding, generic affine/Boolean/clip lineage, authentic
paired-interface ancestry, cap suppression, native/browser wire provenance,
renderer picking/export consumption and final atomic publication remain open.
No cap deletion is implemented. Mixed source/generated faces remain mixed even
when coplanar. Exact remains default; no retained release or licence clearance
is claimed.

## Observed tessellation receipts (#7955, round 5)

**Runtime qualification pending.** The retained round-4 observation contains
254 edge splits with the same 36-notification sequence. The pinned
`SmBrep::MakeVertexSplitEdge` closes with `SM_NO_SPLIT_IN_BREP`, not an edge
`POST_EDIT`. `EdgeSubdivision` recognizes this protocol only within the issued
fixed tessellation frame and its observed internal BRep copy generation.

Each split captures at most 16 incident uses and 16 faces. Constructors issue
fresh edge, vertex, use and curve generations. A matching curve-split receipt
must describe an exact interior partition. Checked restrictions in a separate
callback-free scratch context must match the actual 3D and UV coefficients,
knots, domains and evaluator metadata exactly. Completion checks incidence,
loop linkage, vertex position, unchanged tolerances and incident surfaces.
Installed child trims can originate later observed temporary helpers; the
installed trims themselves remain protected outside this split protocol.
No face root or replacement face identity is issued by edge subdivision.

The operation permits at most 4096 splits and 256 notifications per split,
within the independent read budgets described above. Durable node/event limits
remain unchanged. Geometry serializers retain
their existing coefficient and word limits. Knot snapping, UV deletion and
solver-driven UV reparameterization are refused by this receipt. They were not
present in the recorded observation; success for other affine cases is not
claimed from it. The SDK's terminal split notification is followed only by
output assignment and `SM_SUCCESS` in the pinned release source. Acceptance
still requires actual outer tessellation success, an empty failure report,
no incomplete receipt, retired temporaries, and the exact input seal.

A separate polygon attribute receipt handles `ConvertToPolyBrep`'s final
`SetOriginalFace` call: it must match the original input identity named by the
observed face-copy history and the preceding internal-face polygon attribution.
This consumes correspondence evidence; it never assigns a BRep identity to a
polygon or fabricates an SDK copy map. The source and lineage numerical
positive expectations, tolerances, resource bounds and inherited mutations
remain unchanged.


Round-13 validation is prepared, not executed: the former serial native case
is registered as 13 independent CTest cases with unchanged assertions, plus
three accounting controls (actual destruction/refund, live overflow, callback
overflow). The address-reuse case prints context/callback identity and event
count before reading its constructor receipt. Its notification failure is
not repaired or declared qualified by the accounting change.
