<!-- SPDX-License-Identifier: MPL-2.0 -->
# Independent read-only review: af837bcb731c

Base: `3cdbd93313a612d95792dfaa11cbd1884de56abc`.
Reviewed: `af837bcb731c56ff4bf64008ac1002e389ce704f` in `/home/louistrue/.t3/worktrees/ifc-lite/t3-242432a5` (clean HEAD).
Pinned SDK inspected: clean `c9c5979f04cea8c38213004d4f04df0dcfb40d05` at `/tmp/ifclite-public-sdk-c9c5979/usd-brep`.

## Verdict

One remaining source-backed qualification blocker, inherited from the base and newly reachable if the repaired generated positive succeeds, plus one new diagnostic defect. No additional scoped production-authority blocker found in the fixed constructor transaction. This is conditional source review only: no compilation, syntax command, build, test, benchmark or worker job was run. Repository source and immutable evidence were not changed; only this report and its hash manifest were written under `/tmp`.

## Findings

1. **P1 — Sixth lane still reaches a trimless fixture before its silent-edit controls.** `native/smlib-adapter/tests/root_issuance_tests.cpp:186-189` uses `patch(context,face)` without the ledger. The raw branch at lines 33-42 still returns immediately after `CreateFaceFromSurface`; it does not execute the explicit `CreateUVTrimCurves(FALSE)` added to the ledger branch through `GeneratedPlane::create` (generated_plane.cpp:64-69). In the pinned SDK, `SmBrep.cpp:4324-4374` takes the old algorithm; `MakeFaceWithCurves` calls `MakeFace` with default `bCalculateTrims=FALSE` at 16556-16574. Its later trim creation at 16591-16616 requires the optional CrvOnSurf flag, absent from this call. A fresh four-distinct-edge rectangle also does not take the repeated-edge radial-sector trim path. `GetUVTrimCurve` (SmEdgeuse.cpp:6420-6441) only reads this/mate pointers. Consequently the seal construction at test line 189 reaches representation_seal.cpp:147's missing-actual-UV-trim refusal before any of the three intended silent mutations or their assertions. This is an inherited setup defect, not a regression introduced by the diff, but the increment does not yet supply a complete sixth-lane witness. Materialize genuine trims in the unobserved source fixture before adoption, or use a separately valid prepared fixture; preserve ordinary-construction negative tests and the seal's missing-trim refusal.

2. **P2 — First-latch callback diagnostics can identify the outer callback instead of the failing callback.** `native/smlib-adapter/src/face_lineage_events.cpp:208-215` calls `fail(CallbackDepthLimit)` or `fail(ReentrantCallback)` before installing the incoming operation/caller in the new diagnostic fields. During `previous->Execute`, those fields describe the outer callback (lines 218-220). A nested notifying callback therefore latches the nested refusal with the outer operation/type. The new `fail` snapshot in face_lineage.hpp:101-103 and print at face_lineage.cpp:84-85 freeze that misleading attribution permanently. Record the incoming operation/caller before these early rejection branches and restore outer diagnostic state on return. This does not weaken refusal, but matters when the checkpoint's purpose is locating the first causal phase. No actual seventh-lane cause is inferred from this defect.

## Scoped checks and limits

The constructor exception is private to the exact surface, face generation and synchronous fixed SDK calls; ordinary InitialConstruction, external detach/restore, rooted numerical edits, replacement and trim guards remain active. Owner events match the SDK's preassignment notification convention. MakeFace's restore-old-owner/final-attach sequence and CreateUVTrimCurves' separate detach/RAII-restore pair match inspected source. The 11-transition and separate 2-transition ceilings remain bounded. Exact revision, same-frame generation, complete inventory and retained representation are checked before the receipt is consumed.

Constructor failure disables the exception, abandons the graph and enters the terminal taint path; raw context restoration touches scalar metadata. Fixed ledger tables and bounded seal vectors/work retain their existing restrictions; SDK internal allocations/cleanup are not thereby certified. The extra seal allocations occur after construction, inside the abandon/taint catch, so allocation failure is not a recoverable successful construction. The seal captures supported materialized numerical representation and raw/effective old-tolerance policies, not arbitrary solver/cache state or numerical correctness. Unknown user/system/attribute hooks remain refused; equal final state cannot authorize foreign callback history. No general external-owner or subclass authority is inferred.

Fault8 now copies genuine existing UV trims before SetSurface invalidates them, restores them on their actual owners before adoption, and checks surface homogeneous coefficients/knots plus face domain/rectangular state. SDK curve copying deep-copies the basis but also calls sm_FixupKnotVector (SmBSplineCurve.cpp:196-234); a general exact-copy claim would therefore require direct trim coefficient/knot/domain comparisons. This fixture is the canonical box, not a general copy certificate. The virtual fault records target counts before returning SM_ERR; postfailure checks use saved counters, demand exactly one call after four vertices/four edges, no publication and whole-domain status8. Graph owners are abandoned. Actual execution is still required to establish that the intended virtual seam is reached.

Lane7 remains explicitly unresolved; stage markers and first-latch logging are diagnosis, not a source-causal repair. Parent native-plane V2 paths, opcode21/cap128, Rust/JS, protocol and qualification orchestration are outside this delta. No paired partition, persistent-face or numerical authority is established.

## Evidence identity

The supplied patch and prior actual log hashes match:

- `/tmp/ifclite-generated-construction-af837.patch`: `3b1c6175a7087a746b37aa58d2e5c3bc2b45f795534474594a12b3d2173bd6d3`.
- `/tmp/ifclite-native-ledger-475c-final.log`: `dfb627e7257503e43a79ed83fcfcaf1c6b94d2d2cba75c5e61ec79229482a13b`.
- root_issuance_tests.cpp at reviewed HEAD: `97b91be5a4f536dc45f30ab893e6e463d524a6f9d29715a2c3c5cfd0b4e11f34`.
- face_lineage_events.cpp at reviewed HEAD: `5ed4076b4ccf1405714fa407e8867c79275c3376da3db41f4bb0cda555ad3f48`.

All before/after hashes listed in generated-construction-3cdb/summary.json match the two reviewed commits. Full changed-file and inspected-SDK hashes: `/tmp/ifclite-generated-construction-af837-review-hashes.json`.

The actual log belongs to `475c5edca5ab4c8ba99a92874504240b2fecffe3`: full SDK build/link and original five CTests passed; lanes6/7/8 failed at the documented earlier boundaries. It does not qualify af837. All actual tests for af837 remain UNRUN. Fleet status only was read: Pop and PC admission guard78; Mac disabled.
