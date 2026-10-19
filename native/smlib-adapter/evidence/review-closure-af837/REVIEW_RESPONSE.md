<!-- SPDX-License-Identifier: MPL-2.0 -->
# Additive response to af837 pinned review

Base remains frozen `af837bcb731c56ff4bf64008ac1002e389ce704f`, following frozen
3cdb. The independent report `/tmp/ifclite-generated-construction-af837-review.md`
was read and its SHA256 verified:
`05cde6d70d8ae054ae85abb020c59981fed481f042122f45ac9add0569f35b2a`.
No actual SDK execution qualifies this corrective increment.

P1: `tests/root_issuance_tests.cpp::prepared_patch` now executes the real checked
`SmFace::CreateUVTrimCurves(FALSE)` before adoption and continuous observation
of the silent-edit fixture. It checks exact unchanged face domain and all four
actual live UV-trim owners/dimensions. This adds real missing representation;
it does not guess trims or waive sealed preflight. The ordinary raw `patch`
fixture remains unchanged for ordinary/unknown-construction controls. An explicit
raw trimless patch must still refuse the seal with the actual missing-UV error.

For each of the three existing silent controls, the unchanged seal must first
construct and verify successfully. Stage markers distinguish prepared fixture,
unchanged-seal-verified, and intended-edit-refused. Only then does the test perform
its real silent face-domain setter, retained-original UV-pointer replacement,
or raw trim-control write. It still requires no notifying failure, then exact
representation refusal. Replacement/trim/notifying owner-family and unsupported
history/class restrictions are preserved. No production geometry/seal authority
or missing-data guard changes. All these stages are UNRUN; marker presence in
source is not evidence that execution reached them.

P2: `src/face_lineage_events.cpp::Scope::Execute` now installs the incoming
operation, caller type and prospective event ordinal before either the depth
or reentrancy early latch. A stack-only RAII guard restores the exact previous
context on every return, including depth refusal, nested callbacks and foreign
exceptions. `Ledger::observe` no longer clears this scoped context. First failure
still wins; the scalar `FailureOrigin` query supplies diagnostics only and grants
no ancestry, graph, numerical or operation authority. Bounds/status/callback
chain and restoration behavior are unchanged.

Actual SDK witnesses in `tests/face_lineage_tests.cpp::refusals`: a real face
constructor invokes the foreign callback, which calls an actual unconnected
vertex's `SetPoint` with identical coordinates. The vertex has no incident uses
to emit earlier propagated notifications (pinned `SmVertex.cpp:2402-2459`), and
its real setter emits CHANGE_GEOMETRY (`3255-3260`). Both normal reentrancy and
one-level depth refusal must latch the INNER vertex operation/type/event/frame.
The outer foreign callback also returns SM_ERR; later destruction and scope
exit must not overwrite that first origin. Existing separate real constructor
foreign-error/exception controls now assert their own OUTER operation/type/event.
These are callback behavior witnesses, not fabricated callback event records,
SDK replacements or source-text assertions. All remain UNRUN.

Lane7 is still unresolved. This fixes diagnostic attribution before the parent's
staged trace; it does not infer the failing SDK phase or waive a failure class.
Original5 CTests and independent6/7/8 wiring remain unchanged. Full checked
shared intersection, exhaustive classification, complementary extraction and
source/generated interface ancestry remain required. No op21/cap128, persistent
face IDs, paired closure or numerical qualification is advertised.
