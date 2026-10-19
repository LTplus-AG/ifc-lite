<!-- SPDX-License-Identifier: MPL-2.0 -->
# Bounded event-time face lineage, private source contract

Incremental base `2915e1a3c4c4544f5da64044b2b06e45501ba667`. This implements
the lineage prerequisite from the paired-plane contract. It does not implement
paired splitting, solve discarded SDK classification, or qualify layer output.
Opcode21/capability128 remain unimplemented and unadvertised. Capability123,
operations17–20, the original five CTests and independent sixth are preserved.

The additive [closed-world numerical checkpoint](CLOSED_WORLD_NUMERICAL_CONTRACT.md)
supersedes earlier observer-only callback acceptance: unknown hooks now refuse
ancestry even on SUCCESS. It adds incidence-aware numerical history refusal and
restricted exact source-state comparisons. Notification history, representation
equality and private read-phase identity are distinct; none establishes general
numerical/domain authority. All new SDK witnesses remain UNRUN.

## Identity and authority

`face_lineage::Ledger` issues opaque `(domain, sequence)` identities. Domains are
never reused in one module; sequence numbers are monotonic and bounded. A root
records the independently issued incarnation, live session/slot/generation,
object revision, optional generating operation, and explicit source-boundary,
generated-interface or derived-auxiliary meaning. Its identity names the actual
face bound during complete live-inventory admission, not its current face index.

These are private native object/revision labels, not STEP face authorship,
persistent IFC identifiers, or caller-supplied certificate authority. No API
accepts a `Root` as evidence. The trusted source-issuance caller supplies the
`ObjectRevision` binding and actual faces; this internal struct alone does not
authenticate a live public handle. Parent runtime integration must verify that
binding against the actual issued source/operation and seal the resulting
evidence under its real incarnation, original logical slot and source context.
No public wire or C ABI issuance/acceptance path is added here.

Root admission checks the entire actual inventory before issuing any label:
non-null actual context, revision binding, count, no missing/duplicate/foreign
live faces, exact supported face type and no previously issued/derived history.
The separately reviewed [initial-construction correction](INITIAL_ROOT_ISSUANCE.md)
allows a current audited constructor-only generation to receive its first root;
it does not authorize relabelling arbitrary incomplete history. A
generated label requires an issued generating operation. A faceless source is
admissible only when the existing classifier confirms semantic Empty.

Admission is exclusively for known first source issuance or freshly constructed
derived geometry with an independently known origin. It is never a way to adopt
an arbitrary earlier Boolean/copy result as original source. Geometry already
missing ancestry remains unavailable. The public legacy paths still carry no
certified ledger history; they are not retroactively relabelled by this change.

## Continuous observation and event-time generations

The outer `Scope` installs one chained user callback for the entire lifetime of
rooted objects. Inner SDK phases borrow it and add bounded read-only source
protection. They do not replace it with a second callback. Closing the outer
scope with a live rooted face invalidates the ledger with `ObservationGap`.
A closed observer cannot be reattached. This makes an unobserved destruction/
address-reuse gap a refusal rather than an opportunity to reuse old labels.

`SmFace` constructor/destructor notifications delimit physical lifetimes.
Construction at a previously destroyed address creates an unknown, fresh
identity. Face copies, splits and merges create new immutable event nodes;
reused-parent splits freeze the parent's old identity before updating either
child binding. Merge nodes preserve both input ancestors. A copy onto an
already-mated face unions both histories instead of overwriting the first one.

Records contain event-time identities, not deferred raw payload pointers.
Historical queries walk only immutable nodes. Raw addresses locate current live
bindings during documented notifications/current inventory checks and never
recover historical ancestors. Current bindings include actual BRep ownership.
Unknown sources, retired nodes, malformed events and missing live inventory
cannot produce complete provenance.

An iterative descending-node walk bounds DAG queries and deduplicates shared
roots without recursion or callback allocation. A merge of two fragments from
one source keeps one root and both fragment ancestors. A source boundary and a
generated interface remain two distinct labels even when coplanar. Presentation
must not hide a mixed-origin face merely because one ancestor is generated.

Edge/vertex construction generations also distinguish initialization during the
current SDK phase from later unsupported geometry edits. Unaccounted edits to
established owned vertices, edges or supporting surfaces refuse rather than
leaving apparently complete history. This is intentionally not a blanket
authorization for SDK rebasing/snapping/conversion: those mechanisms need their
own audited operation contract before the paired route can use them.

## Callback, resource and failure contract

Only the user slot is used. The prior callback is chained and restored on every
exit; the SDK's non-nestable system slot is untouched. Callback replacement,
foreign non-success status and foreign exceptions latch failure. No exception
escapes `Scope::Execute`. SDK work can continue after an ignored callback status,
so the caller checks the latch after every SDK phase and before acceptance.
Unissued notifying reentrant edits/construction refuse; callback delivery still
continues within an explicit recursion budget.

Tables and query scratch are allocated before SDK mutation and never grow in
the ledger callback. Default limits are8192 nodes,32768 notifications,1024 roots
and16 nested callback/phase frames. Configuration is checked before allocation,
including a64 MiB aggregate ceiling,65536-node/131072-event maxima and at most64
frames. Construction of transient topology consumes the node budget too. Quotas
are monotonic; deletion does not refund history. SDK/foreign callback internal
allocation is not claimed to be bounded by these adapter tables.

Node/event/root/frame exhaustion produces an explicit resource refusal. Other
history/callback failures produce an unsupported-history refusal. The first
latched error is retained. No reset API erases it. Insufficient caller query
output capacity also refuses explicitly; partial query storage is not a sealed
certificate.

## Checked-copy integration

The existing helper accepts an optional private ledger. With a ledger it requires
continuous observation and complete source history before SDK mutation, borrows
a phase protecting the actual input, and obtains both real `MergeBrep` topology
maps. It checks the latch after construction/map creation and topology copying,
checks the complete output/source inventories, verifies the map bijection and
each mapped face's event ancestry, then checks callback ownership before return.

Without a ledger the existing copy path does not construct optional maps or
install a new callback. It remains explicitly ancestry-unavailable. Raw metadata,
DEFAULT sentinels, immediate constructor context restoration and checked
`MergeBrep(..., FALSE)` status handling remain intact. Direct copies after a
tainted domain now refuse before touching SDK data.

Preflight refusal publishes nothing and performs no destructive SDK work.
After mutation begins, any failed status/latch/map/inventory check reaches the
existing status8 isolation path: abandon potentially unlinked SDK allocations,
restore callback/context guards, preserve the primary failure, and require
process/module disposal. There is no destructor-only cleanup or recovery claim.

## Actual SDK witnesses and evidence state

The sixth `smlib_paired_copy_observability` executable now additionally exercises:

- Two checked copies, complete actual source-root inventory, raw source/context
  metadata and vertex bits, input release and surviving analytical volume.
- Actual `MakeEdgeInFace` splitting of a copied box face and `DeleteEdge` merging,
  distinct fragment generations, both merge ancestors, root deduplication and a
  subsequent checked copy. The original source is protected and preserved.
- Actual already-related `MakeFaceuse` copy onto an owned patch, using two
  identically constructed analytic plane patches. It reaches the no-new-face
  fast path and preserves distinct source/generated roots through another copy.
  This is a notification/ancestry witness, not a shared paired interface proof.
- Actual SDK constructor/destructor address reuse, requiring observed reuse
  within128 attempts. Failure to observe it fails the witness rather than
  silently claiming alias coverage. A derived fixture only exposes protected
  constructors/destructors; it replaces no allocator, geometry or notification.
- Unknown history, fixed node/event quotas, ignored foreign status, callback
  replacement/restoration, protected source setter, established owned-vertex
  edits, observation gaps and permanent refusal of detached root evidence.
- A final actual checked-copy event-budget refusal: no result publishes, the
  caller slot is restored, and unrelated real C ABI handles also return status8.
  Foreign exceptions/statuses are observation-only refusal witnesses; unknown
  hooks cannot enter certified copy preflight. The independent original fifth
  terminal-poison CTest is unchanged.

All actual SDK/native/module witnesses are **UNRUN**. C++17 syntax-only parsing
against the unchanged pinned SDK passes with `-Wall -Wextra` and no owned
warnings. No SDK object code, executable, browser module, Worker or CTest was
built or executed here. Exact hashes and assembly instructions accompany this
increment. No qualification, performance or final-product completion is claimed.

## Next paired numerical work

This supplies event-time ancestry infrastructure, not a paired algorithm. Next:
drive exactly one checked intersection over owned operands, audit its temporary
coordinate changes under the new geometry-history gate, snapshot actual shared
edge/vertex relations after all fixups, and prove exhaustive side classification
over trimmed interiors. The SDK's discarded `bConfused` signal remains a blocker;
SAVE/DELETE cardinality or one sample cannot replace that proof.

Further source inspection reaches an earlier failure boundary too:
`SmTopologyIntersector.cpp:1233–1264` discards the actual
`ImprintIntersections` error before returning `SetRelationships` status;
`ResolveIntersections` at2251–2293 warns on failed vertex/edge resolution and
discards overlapping-edge resolution failure, then returns success. The proto
manager required to drive those phases is private with no getter/setter in
`SmTopologyIntersector.h`. Calling `IntersectInsertRelate` directly is therefore
not a checked replacement. A sound intersection producer must own the public
proto-building/resolution/imprint pipeline and check its real statuses, or
establish independent complete output proof. No private-member bypass or SDK
source overlay is authorized by this finding.

Then implement checked two-sided extraction with explicit shared mate transfer,
opposite cap orientation despite `MakeFaceuse`'s infinite-region override,
complete original/reveal/interface root sets, closed topology, signed volumes,
sections and semantic Empty. Reserve/commit both output identities and one
opaque operation certificate atomically only after every check passes.
Runtime sealing, actual opening history and presentation suppression still need
integration. Retained MaterialLayers, PersistentFaces, OpeningClosure and final
publication remain held. No two-unary-clip replacement or capability advertisement
is introduced by the ledger prerequisite.

The subsequent [private checked face transfer](CHECKED_FACE_EXTRACTION.md)
implements direct status/latch/inventory/fragment checks around `MakeFaceuse`.
It remains insufficient for two-sided partition, cap orientation, region
classification and complete interface proof. Its independent seventh/eighth SDK
CTests are UNRUN; existing five and sixth remain independent.
