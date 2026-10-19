<!-- SPDX-License-Identifier: MPL-2.0 -->
# Fixed numerical reads and exact transferred trims

This additive repair follows frozen dea192. It implements the bounded subset
approved after actual native/WASM failures in the assembled 4a85 source. It is
not a paired partition or a general numerical/domain certificate.

## Actual causes

Native job0468a83b-07c8-4268-be78-5eb2c26ed777 identified source
4a85b7d6de82aae00673db2b025233d800ec3603. Its sixth lane reached and passed the
constructor/silent-edit refusal controls, then failed in the copy/lifetime
witness: UnsupportedGeometryChange, event1164, operation10 PRE_EDIT,
caller14033 SmBSplineCurve. The seventh reached repeated transfer and topology
validation, then failed at the boundary integral: event456, operation7
CHANGE_OWNER, caller15011 SmPlane. The eighth real destructive fault passed.
The parent reports identical sixth/seventh origins in the actual WASM run.
Those results belong to the assembled old source, not this repair. Native
CTest reported5/8 overall; its separate fourth-lane failure is parent-owned.

Pinned source explains the distinct operations. `ComputePreciseProperties`
uses `CreateOrientedTrimBoundary`. This copies a real UV trim, assigns the copy
an original edgeuse owner backlink, then reverses it (`SmFace.cpp:7355-7378`).
`SmBSplineCurve::ReverseParameterization` emits PRE/POST (`5960-5981`). The old
observer follows the backlink and attributes this detached copy's edit to the
actual boundary. `SmCurve::Notify` clears the edited curve's cache, without
propagating the edit into its owner (`SmCurve.cpp:19329-19379`).

Separately, `MakeFaceuse` calls `MakeFace` with default bCalculateTrims=FALSE
(`SmMerge.cpp:7171-7193`). The resulting face can have no UV trims despite
having complete face history. A property read then calls CreateUVTrimCurves
(`SmFace.cpp:7217`), clears the actual supporting surface owner (`8035`) and
creates missing representation. This is real boundary-representation work,
not merely an innocent detached-copy notification; the old refusal was correct.

## Checked transfer repair

`checked_extract_faces` now copies genuine actual selected source UV trims
before face transfer. Class, materialized unborrowed coefficients/weights,
knots, domain, dimensionality and represented evaluator semantics must compare
exactly, excluding only the owner pointer. This deliberately refuses SDK copy
knot fixups or analytic substitutions that change the supported representation.
There are at most8192 unique selected source uses and1048576 aggregate copied
control/knot words. Adapter transfer/matching vectors reserve before SDK copying;
SDK internal temporary allocations are not thereby certified.
Copied supporting surfaces must also retain exact class/parameter representation;
face UV domains must agree bitwise. These checks are comparisons, not general
curve-copy or numerical correctness certificates.

After checked MakeFaceuse, each actual upward target edgeuse must uniquely match
the actual mapped source edge, orientation and both mapped endpoint vertices.
The correspondence must be exhaustive and nonduplicate. Real source and target
UV ownership must be exactly the SDK-selected SM_OT_SAME member: this use when
SAME, its reciprocal mate when OPPOSITE (pinned SmEdgeuse.cpp:4547-4570). Both
members must belong to the exact face/brep/edge with complementary parameter
orientations. The selected member alone stores the exact raw pointer, the other
raw slot is null, and the curve backlink and reported owner must agree. An
arbitrary mate is never sufficient. Existing trims must already compare exactly and
are never overwritten; failed trim history is refused. Missing unfailed trims
receive the retained checked source copy through SetUVTrimCurve, with exact
post-attachment ownership checked. No projection, proximity, tessellation,
normal guessing or lazy numerical reconstruction occurs. The normal complete
target seal must construct and verify before transfer evidence returns. Actual
semantic-empty targets use inventory verification rather than a fabricated
boundary seal. Source inventory, identities, ancestry and its full seal remain
checked after SDK phases. Post-mutation failure abandons operands/operator and
all still-provisional trim pointers with status8; no cleanup is asserted.

This subset requires unique incidence, source-complete trims and exact copied
parameterizations. Repeated-edge/ambiguous uses, converted surface classes,
changed knots, unsupported classes and missing source data remain refusals.
It does not prove material-region classification or complementary cap direction.

## Fixed numerical phase

`NumericalRead::volume` calls the same actual SmApiBrepComputeVolume. `face`
calls actual ComputePreciseProperties for area/volume with zero thickness.
Neither accepts a callable, arbitrary mutator, callback waiver or phase flag.
They require the existing closed-world adapter-exclusive supported graph,
complete root inventory and no foreign hooks. A normal full retained seal
captures actual source topology, numerical representation, current generations,
root revision fields and original context. A private AuditBoundary plus current
frame binds the read; neither marker alone supplies authority. Complete trims
are required before calling SDK; missing trims are not healed by these reads.

The existing preallocated binding table records each actual SmCurve copy-base
constructor whose source argument is exactly one sealed live UV trim. Each
constructor appends a fresh incomplete generation, bound to this exact read
operation and frame. The receipt survives neither destruction nor a subsequent
read. Accepted PRE/POST events append fresh incomplete Edit generations with
explicit event before/after identities. No authored/root/persistent face identity
is issued to a temporary.

Only PRE/POST on a live supported two-dimensional copy can use that receipt.
Its owner must be a known actual source edgeuse, and reverse incidence must
prove that neither that use nor its mate actually stores this copy as its UV
trim. The original attached curves, surfaces, edges, vertices and face histories
keep all old guards. Constructor aliasing an original is rejected. There is no
exemption for arbitrary geometry with a plausible owner pointer. All observed
copy generations must have been destroyed before the SDK call returns; escaped
caches/temporaries refuse the phase. Status and latch are checked, then the
source's exact retained seal and complete inventory must still match before
returning scalars. A failed executed phase taints the whole isolation with the
primary error; no graph cleanup proof is claimed.

Additional adapter storage is bounded: at most8192 trim pointers (included in
the ledger's64MiB admission accounting), existing bounded binding/node/event
quotas, and the existing bounded complete seal. No callback allocation or new
system-slot ownership. Ordinary callbacks still chain/restore and unknown hooks
remain refusal even on SUCCESS. Direct unissued numerical reads still refuse.

The allowlist covers only these two fixed calls and immediate supported 2D trim
copies. Untracked helper descendants, non-2D/other evaluator classes, different
owners, escaped caches, lazy actual boundary edits and any changed source state
are held. Snapshots do not prove absence of hidden/intermediate edits; their
use depends on the audited fixed closed-world entrypoints. A successful scalar
read alone is not general numerical correctness or classification authority.

## Witnesses and qualification

All repaired-source actual SDK witnesses are UNRUN. Syntax-only parsing does
not qualify them. Sixth: direct SmApi volume read remains refused; two fixed
volume reads on the surviving second owned copy must each produce analytic8
and retain exact live face identities and original revision14. Actual transient
PRE/POST events must carry distinct new current-read generations. Existing
constructor, external edit, silent setter, callback, alias/lifetime and failure
controls remain. The later mixed-origin source-sheet fixture also prepares real
trims before root adoption, avoiding the same proven trimless setup defect; its
raw intentionally trimless refusal control is preserved separately. A trimless fixture still refuses both the normal seal and the
fixed properties wrapper before its SDK call.

The additive opposite-use attachment correction after frozen2e557 adds an
explicit seventh-lane real box correspondence witness. It requires actual
OPPOSITE source uses, unique mapped target face/edge/orientation/both endpoints,
and exact target SAME-mate raw-slot/backlink ownership. Stage markers distinguish
canonical attachment verification from reaching complete seal and signed
integrals. Neither marker has been executed for the corrected source.

Seventh: all extracted actual UVs must exist and support a complete seal before
any numerical query. A real detached-copy coefficient change must fail the
exact-copy comparison while the original target seal still verifies. Repeated
mated transfer, pointer/closure checks and fixed actual per-face integrals must
still yield signed volume8 and area24. Generated interface extraction/copy and
release lineage remain required. Eighth preserves the actual virtual surface
fault counter, four merged vertices/edges, no publication and whole status8.

The later sixth-lane MakeEdgeInFace/DeleteEdge split/merge witness has not yet
been reached by parent execution of this source. Its owned topology operations
receive NO numerical-read exemption; any transient supporting-surface changes
there remain a hold for a separately audited topology/numerical phase. Do not
infer that this read repair completes that witness or the pair algorithm.

Parent owns independent review and actual assembled native/WASM qualification.
No child build, SDK execution or heavy submission occurred. No op21/cap128,
final persistent-face authority or layer closure is added. Shared checked
intersection, exhaustive classification, opposite-side checked partition and
shared generated-interface/reveal provenance remain outstanding.
