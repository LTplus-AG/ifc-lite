# Semantic-empty repair 844 review

Reviewed immutable 8441381f544f9877450537609377f93b857c6548 vs7fc91de869 (five changed paths), against pinned actual SDK c9c5979f04cea8c38213004d4f04df0dcfb40d05. No edits, builds, jobs or runtime tests. Parent's syntax-only pass and in-flight actual SDK submission are separate evidence; no runtime outcome inferred.

## Static verdict

No concrete blocker found for valid retained SDK objects. The shared helper correctly recognizes an ordinary topology-vacant BRep without treating raw IsEmptyModel false as material. It rejects any face, edge, vertex or shell; then requires a non-null actual infinite region with strict IsVoid()==TRUE and checks every enumerated region for non-null/strict TRUE plus exact infinite-pointer membership. UNSURE is integer2 and is correctly rejected. All-region material checks protect against void infinite region plus a non-void bounded domain; lower-dimensional geometry is not discarded.

Query and tessellation both call the same helper; certified empty display has genuinely empty owned arrays, while nonempty no-face and failed-face refusals stay in place. C ABI status/shape, protocol opcode and numerical tolerances are unchanged. Header prose now describes boundary/void topology rather than the incorrect raw method claim.

The real SDK direct test is independent of expected Boolean outputs: an ordinary new BRep in the live box context must have raw IsEmptyModel false yet certify empty; actual infinite flag FALSE (full space), UNSURE and recovered TRUE exercise strict material certainty. The real box rejects. CreateWireEdgeFromCurve evaluates endpoints, creates shell/vertices and transfers its input curve into MakeWireEdgeVertex; its documented consumed curve ownership matches the test's raw SmLine allocation. Both unique_ptr BReps are destroyed in reverse declaration order, so vacant/wire and its consumed line are destroyed before the box anchoring their shared context. The wire's zero-face tessellation refusal is actual adapter behavior, not a fabricated failure. Existing actual Boolean identity/empty mesh/source independence/release/null/stale checks remain.

## Scope caveat

mesh.cpp still invokes GetFaces before the helper's own early raw-IsEmptyModel branch. SDK GetFaces dereferences its auxiliary list header. This ordering predates the repair. In this pinned SDK ordinary valid BRep constructors always allocate all headers, and the only inspected assignment clearing all those pointers is the destructor; therefore no supported live retained object reaching this problem was established. Do not turn a destroyed-object test into a valid empty witness. If raw cleared-container support is deliberately advertised beyond valid live BReps, move the shared certificate before GetFaces and remove the redundant source-face assertion in the certified-empty branch. This is not evidence that the current valid Boolean-empty repair is unsafe.

Additional bounded-region material and standalone surface/point negative fixtures are not added; all-region strictness is source-reviewed, while the actual wire fixture positively exercises lower-dimensional rejection. Actual SDK runtime qualification is still required for the new helper and all new/retained assertions.

Pinned hashes: /tmp/ifclite-semantic-empty-844-hashes.json. Earlier failure/misuse reports and original receipts remain untouched.
