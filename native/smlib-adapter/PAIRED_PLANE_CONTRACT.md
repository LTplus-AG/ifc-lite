<!-- SPDX-License-Identifier: MPL-2.0 -->
# Paired plane split: implementation hold and inspected mechanism

Base: `68da7b8a966e0972fa41a0c5d9ab3a48ede19a4c`. SDK:
`c9c5979f04cea8c38213004d4f04df0dcfb40d05`, inspected read-only at
`/tmp/ifclite-public-sdk-c9c5979/usd-brep`. This increment contains an executable
copy-observability prerequisite witness and this engineering record. **It does
not implement paired splitting or durable source/generated interface ancestry.**
Opcode21/capability128 remain reservations. Existing capability123 and operations
17–20 are unchanged. Unary clipping's numerical qualification remains red pending
the parent's repaired-fixture rerun; this increment supplies no numerical verdict.

## Ownership and intended boundary

Owned additions are this document and
`tests/paired_plane_observability_tests.cpp`, with additive CMake wiring only.
There is no native source overlay, SDK modification, protocol/header change,
Rust/JavaScript/common-layer edit, fixture correction or new source authority.
The existing terminal-poison executable/CTest remains separate and unchanged.

The intended operation takes one actual retained input and its original local
metre plane, performs **one intersection**, and returns an ordered negative/
positive pair under one issued operation. It must retain the input lease until
the entire pair, interface and ancestry are accepted. Both handles and all
certificate storage must be reserved before publication. No handle may publish
if extraction, classification, closure, allocation or certificate binding fails.
Any uncertain destructive SDK outcome taints the entire isolation with status8;
no per-object destruction or allocation-cleanup assertion follows uncertainty.

The derived operation certificate is output-only and opaque to callers. It binds
process/module incarnation, original input session/slot/generation, operation
identity, original plane, actual frame/domain/basis, ordered output identities,
actual semantic Empty flags, and exhaustive face/interface incidence records.
It does not assert an authored IFC item, source occurrence or extrusion recipe.
No wire layout or public C declaration is allocated in this increment.

## Primary implementation findings

Locations below are SDK-relative under `source/SMLib/`; they describe inspected
source, not measured numerical behavior.

1. `src/SmBrep.cpp:38618–38721`, `CutBreps`, copies operands with unchecked copy
   constructors, fixes both loop indices to zero, extracts connected face sets,
   and returns success on failed Boolean status. It cannot establish ordered
   closed solids, atomic publication, failure ownership or complete ancestry.
2. `src/SmMerge.cpp:2531–2548`, `SM_BO_SLICE`, admits/orients one sheet.
   The ownership table at2459 returns a single modified host. Its existence does
   not imply paired output or a shared two-sided interface.
3. `src/SmMerge.cpp:2661` checks one `IntersectInsertRelate` invocation. The
   subsequent classification/fixup stages can further modify topology; therefore
   recording only that invocation's first edge arrays would be premature.
4. `src/SmMerge.cpp:3745–3790` collects connected unmarked faces, repeatedly
   evaluates `sFaceEdges[0]` despite looping `jjj`, and continues when no region
   classifies. Its opposite-operand loop has the corresponding failure concern.
   A successful return does not establish exhaustive face classification.
5. `src/SmMerge.cpp:3970–4054` removes duplicate/stale entries, computes a local
   `bConfused`, then continues with `SE_MSG(SM_ERR, ...)`. This local signal has
   no returned field. `inc/SmMessages.h:625–628` defines release `SE`/`SE_MSG`
   as discarded expressions. The adapter builds with `SM_NO_DEBUG_CODE`, so an
   error-message callback cannot recover this particular lost signal. Exclusive
   SAVE/DELETE flags can reject omissions and overlaps but cannot prove that no
   earlier confusion was silently corrected. Cardinality is weaker still.
6. `src/SmMerge.cpp:4060–4157` labels SAVE/DELETE on both imprinted operands
   when an actual Boolean operation uses `m_bImprintAndClassifyFaces`. The enum
   `SM_BO_IMPRINT_CLASSIFY` alone does not supply the desired side semantics:
   classification switches also depend on Union/Intersection/Difference.
   Its early return explicitly resets both context DoingBoolean flags to FALSE
   at4148–4149, rather than restoring their entry values. A new route must guard
   original `GetDoingBooleanRef()` values as well as the existing raw sizing/
   tolerance metadata, on success and failure.
7. `src/SmBrep.cpp:1999–2202`, `CopyFaces`, discards `MakeFaceuse` status with
   `SE` at2087. Using `pOptNewFaces` or equal output counts does not restore the
   discarded construction status. The non-merge branch reconstructs geometry
   and loses attributes; it is not an ancestry-preserving alternative.
8. `src/SmMerge.cpp:6827–7223`, public `MakeFaceuse`, is a better extraction
   building block: its body checks `MergeVertex`, `MergeEdge`, radial sector
   selection, surface copy, `MakeFace` and final face relation status. The
   already-mated fast path notifies a copy but returns no newly-created face
   list. Exhaustive live inventory plus actual mate maps are consequently
   necessary, not just the optional output array.
9. `MakeFaceuse` at6860–6869 forces the source faceuse to the source infinite
   region side. Passing its mate does **not** independently select the opposite
   cap orientation. Negative-side extraction needs an audited orientation/region
   construction and opposite interface incidence; simply calling twice with
   opposite faceuses is insufficient. It also calls `CopyAndAddAnalytics` at7125:
   exact copied face ancestry does not establish coefficient/type preservation.
10. `src/SmBrep.cpp:22849–23420`, `MergeBrep`, supplies explicit forward/reverse
    topology maps and emits per-face `SM_NO_COPY` at23350 after relationships
    are complete. `inc/SmCopyBrepMap.h:20–28` explicitly limits these maps to
    the unchanged pair of topology graphs. They must be consumed before edits.
    The current checked copy passes null maps, but the callback can observe its
    actual source-to-copy face relation without changing that implementation.
11. `src/SmBrep.cpp:13427,15155` emits face `SM_NO_SPLIT_IN_BREP`; face merges
    emit their own notifications (e.g.5975). `src/SmObject.cpp:249–269` calls
    user/system notification callbacks **without consuming their statuses**.
    A provenance observer must latch every failure and check the latch after
    every SDK phase. Returning `SM_ERR` from the observer cannot stop work.
12. `inc/SmTrackTopologyChanges.h:46–88` explicitly describes topology pointer
    reuse and intentionally accumulated unique add/remove lists. That helper
    is not a durable ancestry graph. A pointer can represent several successive
    objects during one operation. Use construction/destruction generations and
    event-time identities; do not resolve historical ancestry from final raw
    addresses. Never dereference stale event payloads after their event.

These findings rule out treating the existing convenience APIs as the complete
contract. They do **not** prove that an adapter-owned algorithm is impossible.
The concrete blocker is the missing checked partition/extraction/lineage
algorithm; advertising the convenience calls would hide that engineering work.

## Smallest remaining cohesive mechanism

1. Reuse the existing non-evaluating source admission, finite-domain proof,
   checked copy and immediate context restoration. Factor reusable cutter/frame
   helpers with their current owner rather than copying `plane.cpp`. The cutter
   must preserve its actual base-face identity and strict other-wall enclosure.
2. Capture actual input face identities before copying, binding them to the
   original retained object/revision. Carry pre-existing generated-interface
   identities and original boundary identities, including opening reveals.
   Root ownership supplies those meanings; a fresh face index cannot reconstruct
   ancestry already lost in an earlier opening Boolean or affine operation.
3. Install a bounded, exception-contained event ledger for copy/split/merge/
   construction/destruction, with event-time identity generations and explicit
   ancestry sets. Restore/preserve foreign callbacks and never take the SDK's
   non-nestable system callback slot. Latch overflow, missing source ancestry,
   unknown changes and callback failure; check after every SDK call. Unsupported
   history must refuse, not become a new original-source label.
4. Intersect the owned host and the single certified cutter once. Snapshot
   actual live cross-operand edge/vertex mate relations after all topology
   changes; verify total one-to-one interface boundary correspondence and loops,
   rather than accepting `IsIntersectionLoopClosed` alone. Its implementation
   at3045–3096 only excludes common vertices of degree one; that is not a general
   interface-incidence proof.
5. Supply exhaustive side classification with checked failure reporting. An
   adapter can drive the lower-level intersection and implement the partition,
   or verify the imprinted partition independently. Checking the release
   SAVE/DELETE flags alone leaves the discarded-confusion contract unresolved.
   Whole-face side verification must cover trimmed interiors, holes and seams.
   The existing full rational control hull generally straddles the plane even
   after its face is trimmed by the intersection; a single sample, vertices or
   whole-patch hull cannot prove each trimmed fragment's side. A checked trimmed
   rational restriction/subdivision or equivalent analytical proof is required.
   Classify coincident/tangent faces explicitly so a source face on the plane
   never becomes a generated interior sheet by location alone.
6. Use checked `MakeFaceuse` calls and explicit mate-map transfer into two
   provisional outputs. Seed interface edge mates from the **same** intersection
   relation, through the first extraction map; do not ask two extractions to
   rediscover shared edges geometrically. Establish the negative cap's actual
   region/orientation contract despite the infinite-region faceuse override.
   Disable topology simplifications that would erase required lineage, or
   record and check every merge before continuing.
7. Check complete copied face inventory, actual face/source ancestry sets,
   opposite shared-interface incidence, loop closure, pointer-report contents,
   manifold topology, void infinite region and signed positive solid volume.
   Actual semantic Empty uses the existing shared classifier. A failed numeric
   phase abandons provisional SDK allocations and taints the domain; it does
   not publish an Empty, one successful side or a cleanup assertion.
8. Only after both outputs and all lineage pass, reserve/commit two output
   slots and one opaque certificate atomically in the existing adapter domain.
   Then add opcode21/header/protocol dispatch and target issuance/acceptance.
   Layer presentation may suppress **only** generated interfaces whose shared
   ancestry is proven. Original faces and opening reveals remain visible even
   when coplanar. Analytical closed slabs alone cannot close this obligation.

## Added actual SDK prerequisite witness

`smlib_paired_copy_observability` is a separate CTest/executable so an earlier
unary fixture failure does not prevent its execution. It runs actual boxes,
actual BRep cylinders and a box converted by actual `TurnToNURBS`. The converted
box is a generic NURBS representation witness, **not** a nonuniform-weight
rational bulge or rational split qualification.

For each fixture it observes every original face's actual copy event, checks a
bijection to the independently owned live output, composes that relation through
a second checked copy, compares original vertex identities/scalar bits and raw
source/context metadata, releases both dependencies, and evaluates manifold and
analytic volume on the surviving copy. Its non-allocating observer deliberately
returns `SM_ERR`; successful checked copying with the observer's refusal latch
set exposes the ignored-status behavior using real SDK execution. It provides no
successful mock geometry. A tainted copy releases all owned pointers before
ordinary test-scope destruction; the isolation then exits with failure.

**Execution status: UNRUN.** Syntax-only C++17 parsing against the pinned headers
passes. This neither links SDK implementations nor exercises notification,
volume, release lifetime or CTest behavior. No copied object from this witness
is published through the C ABI. It is not the missing split failure/no-handle
publication test, nor a stable source-identity authority for consumers.

## Paired qualification witnesses still required

All rows below are **NOT IMPLEMENTED / UNRUN**, not skipped passing tests. They
must run against the eventual actual pair operation, including a real module
Worker separately. Source-bound results from unary clips cannot substitute.

| Actual fixture | Independent numeric and ancestry obligations |
| --- | --- |
| Box `[0,2]^3`, plane `x=1` | Ordered signed volumes4/4; section at `z=1` area2/2; one shared cut interface area4, opposite incidence; all original boundary fragments accounted for. |
| Box `[0,2]^3`, plane `x+y+z=3` | Volumes4/4; section at `z=1` area2/2; interface area `3*sqrt(3)`; identical shared boundary identities through extraction/copy. |
| Cylinder radius1, `z=[0,2]`, plane `x=0` | Volumes pi/pi; midsection pi/2 each; shared interface area4; reached curved side/caps, seam and cylinder representation. |
| Same cylinder, plane `x+z=1` | Central-symmetry volumes pi/pi; `z=1` semidisk sections pi/2; interface area `pi*sqrt(2)` with shared curved-edge ancestry. |
| Genuine weighted rational trimmed BRep | Author positive nonunit homogeneous weights and true trims; independent signed integration and sections fixed before observing output. Reach a curved face interior beyond vertex bounds; prove both shared interface and every source fragment. A converted planar box does not discharge this row. |
| Degree2 box top interior control z6, other controls z2, weights1 | Polynomial control case: `z=2+16*u*(1-u)*v*(1-v)` with `x=2u,y=2v`. Total volume `88/9`, x1 halves `44/9`; interface area `16/3`, z1 sections2/2. Retain true trims when replacing the patch. This supplements, not replaces, the nonunit-weight row. |
| Already-voided host with overlapping opening and coplanar reveal | Original reveal ancestry survives both bands and copies; presentation suppresses only the paired generated interface; no doubled sheets, missing reveals, cracks or T-junctions. Compare external shell incidence, not closed volume alone. |
| Empty/disjoint/tangent/coincident plane, both orientations | Actual semantic Empty per output; source-plane boundary never falsely classified generated; no false interface when there is no material on both sides. |
| Source/output release, slot reuse and repeated band splits | Immutable original coordinates/coefficients/metadata; output survives all dependencies; historical source/interface labels survive copies and later splits without pointer aliasing or a forged authored source. |
| Confused/absent/duplicate classification, unknown notification and failed extraction/allocation | No handle or certificate for either side; uncertain destructive failures poison the domain with status8 and block all later operations. Keep the existing separate poison CTest as well. |

No heavy build, test, numerical job, new target directory, PR, push, merge,
cleanup, external project reference or baseline/tolerance change was performed.
The parent owns live root job `00939a61-7797-48a0-a104-cb7657915d72` and coordinates
all compiled execution. This increment must not be used to clear retained
MaterialLayers, PersistentFaces, OpeningClosure or final publication holds.
