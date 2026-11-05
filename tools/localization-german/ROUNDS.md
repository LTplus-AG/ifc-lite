# Improvement ledger (maximum eight rounds)

## Round 1 — implementation (in progress)

Scope: 158 feature catalogues, split into three balanced file-disjoint translation
jobs with real catalogue/caller context. Existing Russian entry/folder pattern;
existing locale activation preserved. Acceptance written before review.

Changes/evidence/findings: pending translation completion and loaded-object audit.
Stop decision: continue to deterministic checks and independent review.

## Round 2 — evidence-driven semantic corrections (in progress)

Independent gpt-6-astra high review found one major inherited English defect
(GLB SurfaceColour/DiffuseColour descriptions reversed against canonical Rust
resolver and actual exporter), plus three German defects (section box called a
field, cross-section called Abschnitt, drag release called freigeben). Corrected
EN/DE colour guidance and the four affected German interaction messages.
Review evidence: REVIEW-SEMANTIC.md; no native-speaker claim.

Stop decision: continue until catalogue coverage, runtime and root checks pass.

## Round 3 — startup and maintenance integration

Independent coverage review found 98 lazy retained-geometry messages rejected
before English registration, masked by the loaded-object test. Added bounded
startup metadata through the existing lazy validator plus an isolated real
German startup regression before/after English feature registration. Metadata
is compared to the actual lazy catalogue object. No framework replacement.

Reassembled all 158 feature exports into the shipping entry; loaded-object audit:
10,607 English keys, 10,607 German keys, 0 missing, 0 unknown. Replaced Poly/Box
UI abbreviations with Polylinie/Schnittbox. Reconciled 468 value-pinned identical
messages with explicit reasons; same-spelling German terms are acknowledged.
Documented the sole intentional empty count-unit suffix, rather than treating
it as untranslated. See REVIEW-COVERAGE.md for the original observations.

Stop decision: continue to root checks and observable real-model workflow.

## Round 4 — stable committed test typing

The clean PC-worker typecheck of commit 866a6fd726 found TS7022/TS7006 in
the added plural invariant and TS18046 in the startup test. The earlier local
typecheck had passed while tests were still being added; it cannot certify
these final additions. Added explicit string/parameter types and a typed
TranslationValue parameter helper. Catalogue translations are unchanged.
Original receipt: auto-66a81bb063ce47feaf71b1a6a4977456, worker
df5994ae-c487-4a52-87b9-0f06fa520864, exit 2, source unchanged.
Stop decision: revalidate the corrected committed source; browser acceptance
remains pending.

## Round 5 — observed validation-authoring grammar

Real-model browser acceptance passed ten checks on hardware Intel WebGPU, with
no page errors. The same rendered workflow exposed four grammar defects in the
validation library (wrong grammatical gender/case and reversed delete label).
Corrected validationPanel.library.none/import/copy/delete after inspecting the
DefinitionLibraryToolbar actions. No schema names or parameters changed.
Evidence: WORKFLOW.md, screenshots and exact runtime hashes under local evidence/.
Stop decision: rebuild/test these final message repairs and verify the corrected
rendered authoring labels before final handoff. No sixth round unless defects
remain.

### Round 5 final evidence and stop decision

Final root graph: 62 tests passed, 0 failed, 0 skipped across 14 selected files.
Final GPU rerun: 10/10 checks passed, no page errors, actual render and repaired
library accessible controls verified; source aea79e9a1c. No known major meaning
defect remains in reviewed workflows. Both protected campaigns remain identical.

Stop after 5 of 8 rounds: functional acceptance demonstrated. Final aggregate
Pre-Handoff/root lint are externally blocked by a foreign cache lock on the PC;
original request auto-0fce1bb98b224ca5af396a9d93a374d4 remains queued and must not
be resubmitted. REPORT.md gives exact request, blocker, failures and skipped
coverage. This is not an all-gates-green claim or native-speaker approval.
