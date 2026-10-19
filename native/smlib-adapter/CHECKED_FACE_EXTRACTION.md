<!-- SPDX-License-Identifier: MPL-2.0 -->
# Private checked face transfer prerequisite

Additive after first-issuance correction `ef2b75163f`. This implements a checked
source-direction face transfer, not a complete checked paired extraction.
No public wire, handle allocation, opcode21 or capability128 is added.

The subsequent [closed-world source-read checkpoint](CLOSED_WORLD_NUMERICAL_CONTRACT.md)
adds restricted retained source-state comparisons and unknown-hook refusal.
It does not turn this transfer helper into complete checked paired extraction.

`checked_extract_faces` requires actual separate owned operands in one context,
the public `SmMerge` relation owner binding those exact ordered operands, a
continuously attached ledger, complete source/target face histories and a
bounded unique selection from the actual live source inventory. A faceless
target is admissible only when actually semantic Empty, not a wire or full space.
The internal trusted caller still owns geometry-domain validation. The helper
checks attached faceuses/surface but does not turn arbitrary damaged SDK graphs
into safe inputs.

Bounded snapshots capture selected fragment identities and all pre-existing
target identities before mutation. There are at most65536 faces per operand,
131072 snapshot identities and65536 returned transfer records. Adapter vectors
reserve once before mutation; allocation refusal has resource status. SDK
internal allocation remains outside this bound. Existing ledger quotas remain
monotonic and the callback allocates no expanding storage.

Each actual `MakeFaceuse` return status is checked, followed by the callback
latch and complete actual inventories. The source face's mate is compared with
the live target inventory before dereferencing a map result. Exactly one live
target must descend from that source's frozen fragment identity; root overlap
alone is insufficient. Every final target face must descend from one selected
fragment or a pre-existing target fragment. Final transfer identities are read
after all SDK steps because later merges/copies may advance generations.
The already-mated path is supported without trusting the optional new-face
array; the SDK emits COPY while returning an empty new-face list there.

The helper protects source mutations through the ledger, preserves raw context
metadata and scopes editing/Boolean flags. Preflight refuses before extraction.
After a potentially destructive SDK call, any failed status, callback, inventory
or ancestry check abandons the isolation through existing status8 and preserves
the primary error. Caller-owned operands AND relation owner must be abandoned.
There is no destructor-only allocation cleanup claim and no handle publication.

## Source-backed failure boundary

At immutable SDK `SmMerge.cpp:2087`, `CopyFaces` uses `SE(MakeFaceuse(...))` and
can discard its failure. This helper instead calls the public function directly.
At6827–7231, `MakeFaceuse` checks vertex/edge transfer and face construction with
`SER`. At7125 it checks actual virtual `CopyAndAddAnalytics` after boundary
vertices/edges may already have been merged. A fault fixture copies the actual
box surface's B-spline representation into a derived surface whose only changed
behavior is to return `SM_ERR` with a null output at that virtual call. It
supplies no fabricated successful geometry. The witness requires that seam was
reached exactly once, no transfer evidence returned, the primary extraction
error survived, the caller callback was restored, the system slot stayed
untouched, and unrelated real public handles reject access/reset with status8.
After taint it reads only its external fault counter and guard scalars; it does
not inspect partial SDK topology or invoke its destructors.

## Actual witnesses and qualification

A new independent seventh CTest, `smlib_checked_face_extraction`, runs actual box
all-face transfer, repeated mated transfer, exact fragment ancestry, source raw
metadata/coordinate invariants, pointer-report collection, manifold/trim closure,
and bounded-side faceuse integration against analytic signed volume8/area24.
It integrates the actual boundary without assigning guessed material flags.
It also constructs a real generated plane inside `InitialConstruction`, issues
its first generated-interface root, extracts it and copies it again with the
same opaque operation/revision binding. Duplicate selections and reversed
relation owners refuse before mutation. The terminal surface-copy fault runs
alone in an eighth CTest, `smlib_face_extraction_failure_boundary`, so a positive
transfer failure cannot mask its result. Original five CTests and sixth stay
independent. Both new lanes share an executable but run in separate processes.

These SDK witnesses are **UNRUN**. C++17 syntax-only parsing against the pinned
unchanged SDK passes with `-Wall -Wextra`. No build, CTest, numerical result,
module qualification or performance claim is inferred from that parsing.

## Exact remaining pair work

`MakeFaceuse` still invokes `sm_FindBrepRegionOfOtherFace` (186–314), whose sector
and point-classification failures can be skipped. It also forces source
infinite-region faceuse orientation at6868. Therefore a successful checked
status/lineage transfer is NOT exhaustive partition/classification proof and
does not establish the opposite cap orientation. It does not set material-region
flags; SmMerge's later region pass normally performs that separate operation.
Other lower-level discarded numerical statuses still require independent proof.

Exactly one checked intersection producer must still be implemented: own public
SSI/proto creation, resolution, imprint and relation transfer with all failures
checked, or independently prove exhaustive valid partition. Direct
`IntersectInsertRelate` discards imprint/resolution failures and has a private
proto manager; no private-member bypass or SDK overlay is introduced here.
The ledger intentionally refuses unaccounted established geometry edits during
SDK fixups. Those fixups need their own source-backed numerical/history contract.

Then prove all trimmed interior sides, transfer shared cut incidence and one
generated interface identity, select opposite caps, classify all result regions,
prove closure/sections/signed volumes/semantic Empty and commit both output
identities plus sealed derived-operation evidence atomically. Regularized opening
regions need explicit provenance; analytical closed slabs do not establish real
reveal ancestry. Presentation must retain source/reveal boundaries even when
coplanar with generated interior interfaces. These requirements remain held.
