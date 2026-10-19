<!-- SPDX-License-Identifier: MPL-2.0 -->
# Read-only closure review: dea192484d99

Reviewed `dea192484d99dc9d6713d25f478c7bddd2eaf871` versus `af837bcb731c56ff4bf64008ac1002e389ce704f`, including the combined af837+dea192 constructor, seal and diagnostic changes against `3cdbd93313a612d95792dfaa11cbd1884de56abc`. Worktree: `/home/louistrue/.t3/worktrees/ifc-lite/t3-242432a5`, clean at reviewed HEAD. Inspected actual clean pinned SDK `c9c5979f04cea8c38213004d4f04df0dcfb40d05` in `/tmp/ifclite-public-sdk-c9c5979/usd-brep`.

## Verdict

Both prior findings are closed at source-review level. No new scoped production-authority blocker found. This is conditional source closure, not SDK execution or numeric qualification. No repository edits, compile/syntax command, build, test, benchmark or worker job was performed; only this report and its hash manifest were written to /tmp. The submitter's syntax-only PASS is source parsing, not numerical evidence. All actual tests of af837/dea192 remain UNRUN.

## P1: closed in source

`tests/root_issuance_tests.cpp:46-66` now prepares only the silent-edit positive fixtures through the actual checked `CreateUVTrimCurves(FALSE,...)` before root adoption. It requires all four upward edgeuses, a real 2D trim with the exact live reported owner for each, and bit-identical face domain. Each of the three mutation controls constructs and verifies an unchanged RepresentationSeal before performing its actual domain, pointer or coefficient mutation; it then requires no observer failure followed by RepresentationChanged. Stage markers distinguish those boundaries but are not execution evidence.

This addresses the pinned SDK's old CreateFaceFromSurface/MakeFaceWithCurves path: MakeFace defaults to not calculating trims, while GetUVTrimCurve only reads an existing use/mate pointer. The new preparation calls the genuine SDK trim-building API rather than fabricating data or relaxing the seal. The raw ordinary construction path remains unchanged. A separate raw trimless source now must throw the exact missing-actual-UV-trim seal refusal before cleanup. Ordinary constructor/unknown-history negative controls and production missing-trim checks remain intact. Thus the identified deterministic setup gap is removed; actual positive feasibility still needs execution on the pinned SDK.

## P2: closed in source

`src/face_lineage_events.cpp:206-231` installs incoming operation, caller type and prospective event ordinal before either depth/reentry latch. A scalar stack guard restores the previous context on early depth return, normal return and contained foreign exceptions; observe no longer clears that context. The immutable first latch still wins. Only Scope::Execute calls observe, so moving context ownership does not leave a second direct caller uncovered. A rejected nested event's ordinal denotes the attempted next event, not an appended record.

`tests/face_lineage_tests.cpp:335-374` uses an actual face constructor and an actual unconnected SDK vertex SetPoint to exercise both nested reentry and depth-one refusal. Pinned SmVertex::SetPoint notifies before assignment; SmVertex::Notify propagates to existing uses first, and this vertex has no uses. The witness therefore targets the incoming vertex CHANGE_GEOMETRY rather than relying on a fabricated event. Assertions check inner operation/type/event/frame and retain first origin through outer foreign SM_ERR, destruction and scope exit; separate foreign status/exception tests check outer constructor attribution. The failure_origin accessor is diagnostic scalar evidence only. No ancestry or operation authority follows from it. These witnesses remain UNRUN.

## Combined constructor and guard context

The af837 fixed constructor retains a private, synchronous exception for its exact newly created surface, live constructor face generation and construction frame. It checks actual old ownership and bounded transitions (11 for initial face construction, exactly two for explicit trim detach/restore), rejects complete/rooted faces, and does not authorize arbitrary owners. Pinned CreateUVTrimCurves has the inspected detach plus RAII restore sequence. Same-revision receipt, actual live inventory, retained representation and initial history are required before root issuance consumes the receipt. Ordinary external detach/restore, replacements, unsupported history and numerical edits retain their guards.

The seal's special initial capture remains private to this exact receipt; supported materialized representation, actual UV trims, owners, topology and numerical data are still captured. The owner exception is disabled before sealing and in failure cleanup. Constructor failures abandon the SDK graph and enter existing terminal taint handling; scalar context restoration does not re-enter the abandoned graph. No broader SDK allocation/cleanup or arbitrary subclass contract is certified. Dea192 changes only diagnostic production fields/control context and the two test files; all 13 listed safeguard paths exactly match af837 and the evidence hashes.

Lane7 stage diagnostics identify admission, constructors, preflights, transfers, topology validation, integral, copy and release boundaries. They do not repair its unknown cause. The af837 lane8 fixture preserves real existing trims around SetSurface before adoption and captures target vertex/edge counts inside the actual virtual fault seam, avoiding post-taint graph reads. Its real seam reachability remains unproven until execution; copied general curve representations are not thereby certified byte-identical beyond the stated canonical fixture.

## Remaining objections and integration constraints

1. Actual pinned full native8 execution is still required. `/tmp/ifclite-native-ledger-475c-final.log` belongs to 475c5edca5ab4c8ba99a92874504240b2fecffe3: full SDK build/link and original five tests passed, while lanes6/7/8 failed. It provides no passing evidence for af837/dea192.
2. Lane7 remains unresolved and needs the actual first-causal trace and a reviewed cause-specific repair. Do not infer the SDK failure from source stage markers or diagnostic correction.
3. Complete paired intersection/classification/extraction/interface ancestry, native/runtime sealed issuance authority and final persistent-face contract remain open. No opcode21/cap128, paired closure, numerical correctness or performance claim is established.
4. Incremental parent composition must preserve existing plane/runtime work and frozen evidence. Apply only the four source/test changes plus additive closure evidence after af837; do not overwrite parent plane/runtime paths with this checkout's versions. The composed source needs its own actual validation.

## Evidence identity

The supplied patch SHA256 matches `9ad8ee0ff3df89fad3c26bae95681b55399f0d9f9f4b6ccc890869c65a9f1108`; prior review matches `05cde6d70d8ae054ae85abb020c59981fed481f042122f45ac9add0569f35b2a`. Every before/after changed-file hash and unchanged-safeguard hash in review-closure-af837/summary.json was independently verified against the commits. Full reviewed source, SDK and evidence hashes are recorded in `/tmp/ifclite-review-closure-dea192-review-hashes.json`.

Fleet status only: Pop and PC reachable but admission refused with guard exit 78; Mac disabled. No job submitted and no foreign evidence or active work altered.
