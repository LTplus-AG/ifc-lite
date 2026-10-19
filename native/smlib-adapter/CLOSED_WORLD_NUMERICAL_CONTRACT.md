<!-- SPDX-License-Identifier: MPL-2.0 -->
# Bounded owner mutation and source-read seals

The later [fixed numerical-read repair](CHECKED_NUMERICAL_READ.md) adds exact
source UV transfer and generation-bound detached trim copies inside two fixed
SDK property calls. It preserves complete source seals and all ordinary edit
refusals; it grants no arbitrary numerical phase or public certificate authority.

This additive checkpoint follows frozen `a0a589cd78a7436a683bb8df679fed9913af8533`.
All earlier commits/evidence remain historical and unchanged. This source is
**UNRUN against the actual SDK**. Syntax parsing is not numerical qualification.
No operation21/cap128, public root wire, paired result or layer closure is added.

## Three distinct kinds of evidence

1. The notification ledger records actual observed constructor/copy/split/merge
   history with immutable event-time identities. It does not observe silent SDK
   setters or prove that every numerical edit notified.
2. `RepresentationSeal` retains exact typed boundary-state words and compares
   them bit for bit. It does not use a probabilistic hash. Equality cannot prove
   absence of hidden/intermediate edits, correctness of an SDK algorithm,
   geometric equivalence of different representations, or a numerical domain.
3. An internally issued `AuditBoundary` identity identifies one private read
   comparison. It is not a paired derived-operation certificate, an authored
   boundary ID, or authority to run an arbitrary numerical operation.

These private records bind the actual source/context, current live face
generations and retained root object incarnation/session/slot/generation/
revision/operation fields. Runtime authentication/sealing under the actual
incarnation, original logical slot/source context and current issued object
revision is still required. An integer tuple, construction flag, snapshot,
private read marker or caller-provided hash alone supplies no certificate
authority. Copies retain original root bindings; those are not newly invented
public slot/revision bindings for the copied object.

## Closed-world operation boundary

SDK graphs must remain exclusively adapter-owned from known first issuance
through observed release. Existing geometry with lost ancestry, raw external
edits, arbitrary subclasses/hooks and unknown mutation entrypoints are not
adoptable by this seam. `InitialConstruction` remains a trusted internal
constructor precondition, not proof that arbitrary code run inside a Scope was
an audited constructor. In particular, a snapshot created after an unknown
silent edit cannot establish the earlier original shape. General first-issuance
factory receipt/runtime authority integration is not implemented by this patch.

The only production integrations of this source-read seal are the existing
private `checked_brep_copy` and `checked_extract_faces` helpers. Neither takes an
arbitrary SDK callback/mutator for execution. Each requires explicit source
lineage, owns its fixed SDK call sequence, checks statuses and callback latches,
and verifies the retained source state after potentially destructive phases.
The seal is constructed before those phases. Extraction seals after its scoped
Boolean/edit flag setup and checks before the guards restore those flags.
This certifies neither the new target's numerical equivalence nor its partition.
Broader Boolean/fixup/mutation entrypoints remain unavailable pending audit.

Foreign user callbacks remain chained/restored on observation/refusal paths,
but ancestry admission and inventory acceptance refuse them even when they
return SUCCESS. The same applies to unknown system/attribute hooks. This patch
does not take the system slot or assume that successful foreign callbacks were
read-only. A refusal still preserves callback status/exception latching and
bounded delivery. No exception is thrown through the SDK callback.

## Notifying mutation audit

`face_lineage_geometry.cpp` resolves supporting surface/curve owners through a
bounded live owner walk. Edge/vertex incidence walks use actual circular use
lists, owner/count/type checks and bounded work, without allocating SDK arrays
inside callbacks. Surface edits affect their face; UV trims affect their owning
face sector; 3D edge curves and vertex setters affect all incident faces.

| Actual route in pinned SDK | Treatment |
| --- | --- |
| `SmEdge::Replace3DCurve`2451–2477 → `SetCurve`2493–2545 | CHANGE_GEOMETRY old-curve slot distinguishes first null attachment from replacement; affected constructors lose eligibility; rooted faces latch. |
| `SmVertex::SetPoint`3255–3260 | Only the first actual setter of a fresh generation is initialization; later setters revoke affected constructors. Rooted incident faces have no newborn exemption, including identical-bit writes. |
| `SmPlane::TrimWithDomain`3260 onward | Actual surface PRE_EDIT follows its owner to the face and revokes/refuses history, including equal-domain early returns. |
| Owned 3D/2D curve PRE/POST/CHANGE_GEOMETRY | Follows actual numerical ownership into edge incidence or trim face. |
| Numerical SPLIT/MERGE | Checks caller ownership, documented owner slot and both merge originals; these are numerical edits, not face-fragment lineage authority. |
| CHANGE_OWNER | Checks documented old/new owners; initial attachment differs from transfer or detachment. |
| Face PRE/POST and topological trim/split | Retain the existing topology ledger contract. `MakeEdgeInFaceWithVU` emits face PRE for a topology split (SmBrep12710/13318); it is not by itself evidence of a supporting-surface numerical edit. Incomplete constructors still lose eligibility. |

No raw final address recovers an ancestor. Numerical initializer state is reset
only by an actual new constructor generation, not by ending/reopening a phase.
After roots, initialization never excuses mutation of an affected rooted face.

Silent routes are explicitly separate: `SetUVTrimCurve`4473–4718 emits no notify,
and `SmCurve::SetOwner`718–735 suppresses 2D/UV owner notifications. `SetUVDomain`,
`SetInterval`, `SetUVPoint`, no-notify setter options and raw coefficient writes
also require the exclusive audited-entrypoint contract and exact phase-boundary
comparison. They cannot be made observable by adding another callback flag.

## Supported representation boundary and resources

This exact comparison supports only the pinned OLD tolerance build and the
bounded materialized graph subset below. Unsupported states refuse; they are
not normalized, guessed, sampled or relabelled to make comparison pass.

- Nonempty, unattributed generic face/edge/vertex topology with actual regions,
  shells, faceuses, loops, loopuses, edgeuses and vertexuses. No wire edgeuses,
  failed drop-curve states, missing UV trims, external/cross-context geometry,
  specialized topology or faceless shape authority is supplied here.
- Supporting `SmPlane`/generic `SmBSplineSurface` and `SmLine`/generic
  `SmBSplineCurve`, with actual existing unborrowed NURBS data. Cylinders/cones,
  other evaluator classes, power-basis surfaces and missing data remain held.
- All actual topology owner/next/last/child links and counts; loop/use/mate/radial
  orientation/incidence; region void flags; face UV domain/rectangular flag;
  edge interval; vertex point and stored vertexuse UV; UV trim pointer ownership;
  homogeneous controls including raw weights/sentinels; all knot values and
  degrees; canonical form/knot metadata; natural/analytic domains; plane frame/
  scale and line point/vector/scale/inside-out; extrapolation and surface solver
  mode; leaf OLD tolerances, raw source/context DEFAULT metadata, effective
  global tolerance policies and scoped Boolean/edit/validate flags are retained.
- Lazy evaluation, healing, GetOrCreate/MakeNurb and geometric validators are not
  comparison authority. Getter calls require an existing representation. SDK
  caches/marks are not a claim of mathematical truth; independent numerical
  validation and the restricted operation audit remain mandatory. This patch
  supplies no general cache/solver/domain correctness certificate.

Each seal reserves two1048576-word tables and one8192-object worklist before
SDK mutation (about16.1 MiB of adapter heap), with65536-element bounded knot
scratch, a1048576-step dedup/owner budget and explicit coefficient/topology
limits. No representation snapshot runs inside the notification callback.
Ledger storage remains separately bounded (at most64 MiB); SDK getter/internal
allocation is not claimed to be constrained by those adapter tables. Comparison
failure latches history unavailable; failed checks after SDK mutation in the
production helpers reach the existing status8/primary-error/abandon path.
Preflight unsupported data refuses before their destructive SDK work.

## Actual witness map — all UNRUN

| Witness/function and CTest | Actual behavior required |
| --- | --- |
| `run_root_issuance_tests`, sixth | Unchanged real generated patch under the continuous observer → first generated root → checked copy and surviving revision/root label. Missing/duplicate/relabel/ordinary/expired/replacement refusals remain. |
| Same-frame mutation loop, sixth | Before and after roots: real edge Replace3DCurve, vertex SetPoint, 2D trim reparameterization, surface TrimWithDomain and owned 3D curve reparameterization. Before roots admission refuses; after roots UnsupportedGeometryChange latches even while leaves are newborn. |
| Silent breach loop, sixth | An unchanged retained seal first verifies; actual silent face-domain setter, UV trim swap (old trim retained through comparison), or raw trim-control write produces no observer failure, then exact comparison refuses with RepresentationChanged. These deliberate test breaches are not authorized production entrypoints. |
| `refusals`, sixth | A SUCCESS foreign callback actually changes and restores a face UV domain between phase boundaries. Admission is refused as UntrustedCallback; equal final state cannot grant history. Callback chaining/restoration still occurs. Actual constructor callback exceptions/non-success also latch without crossing SDK. |
| `copy_lifetime`, sixth | Real sealed checked copies, preserved original metadata/coordinates, complete root sets and observed release lifetime. Foreign callbacks no longer qualify this positive lane. |
| Final copy-budget fault, sixth | Actual checked copy exceeds the event quota after SDK work; no result publishes, primary isolation taint survives and unrelated handles return status8. This replaces the former certified-foreign-callback fault setup, now refused at preflight. |
| `box_transfer`/`generated_transfer`, seventh | Existing actual extraction/closure/integration/root lifetime assertions plus source-read comparisons. Their analytical expectations remain unexecuted assertions, not measured results. |
| `terminal_failure`, eighth | Existing actual virtual surface-copy SM_ERR seam, no transfer return, callback-slot restoration and unrelated-handle status8. Unknown foreign hooks are excluded before this destructive lane. |

Original five CTests and independent sixth/seventh/eighth process boundaries
remain intact. No heavy build/job or SDK execution was performed. New native
source syntax parses against immutable c9c5979 headers; no numerical result,
runtime product behavior or performance verdict follows from that parsing.

## Review boundary and remaining goal

Freeze this bounded subset for independent pinned review and parent-owned actual
SDK execution. Do not expand its semantics or equate these records with general
numerical/domain authority. Pair completion still requires one fully checked
intersection/partition, exhaustive trimmed side classification, opposite-cap
orientation, all result material states/closure/sections/volumes, proven shared
interface and original/reveal ancestry, and atomic output/certificate publication.
The SDK's discarded intersection/classification failures remain unresolved.
