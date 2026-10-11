# IDS Studio recovery — 2026-10-10

The maintainer asked campaign root `t3code-57868bf7` to pick up useful old PRs. This is the recovery order for their preserved source. It records a source inventory and work to execute; it does not qualify any implementation or restart the stopped original pitch workers.

The coordinating owner confirmed on #7143 that all five interrupted workers stopped on 2026-10-08 and all local changes were pushed. No timestamp or checked backlog row is evidence of runtime acceptance. Register the next worker and its exact starting head in a PR comment before changing a pitch branch. Preserve checkpoint commits and archived evidence; split future work at meaningful backlog boundaries rather than rewriting the preserved history.

## Starting points and dependencies

| PR | Published head at recovery | Actual base | Useful source and next bounded step |
|---|---|---|---|
| #7143 | `3cf4fdf68842b69528b2c0049b1319133aaeb559` | main | Campaign docs, accepted decisions, retained P-05/P-09 work logs. This recovery update extends the tracker only. |
| #7171 | `4e36dfc588f55e15b3c2095023c1b2aa8e53dd18` | main | P-01 writer/audit/schema prerequisite. Integrate current main normally, qualify corpus and audit corrections. Coordinate the P-08 audit pin in the same integration step. |
| #7168 | `edd59c7b92b07a3a0780a24ff3a6b53ab865b4b5` | main | P-02 canonical document, gate, inverse history and bundle prerequisite. Qualify these invariants before dependent UI or agent edits. |
| #7144 | `745b27441cb17a0ba309befb8d3b08f72f2be594` | P-02 | P-04 lint engine, 43 rules and mutation evidence. Revalidate against the qualified core, independently review precision labels and answer the existing suppression/severity questions. |
| #7145 | `e8aa7a81ffc9a9d289d29e487464489e150dc18b` | P-04 | P-03 interrupted viewer checkpoint. Map actual components/tests to IDS-030–045, check lifecycle and ops-only writes, then capture real-model UI evidence. |
| #7147 | `baca3552f86c23228feac2d2878ba5d1f882a7f6` | P-04 | P-06 bSDD adapters, mappings, generation, URI health and cache. Qualify the recorded-fixture behaviour, complete provenance/licence records, then integrate the P-03 picker. |
| #7148 | `7e18628c88108ea22101b38006c8196b17474845` | P-04 | P-07 agent package and assistant checkpoint. Qualify fake-model grounding, proposal acceptance, privacy, cancellation and deletion coverage before enabling the new viewer path. |
| #7149 | `237de592ec9549b6d1dbca47423dae0ab931f7df` | main | P-08 E2/E4/E5 datasets and scorer, not a completed agent runner. Revalidate scorer mutations and reconcile P-01 pins; preserve pending human review and licence decisions. |

P-01 and P-02 are independent preparation lanes. P-04 follows P-02; P-03/P-06/P-07 follow P-04. P-06 picker UI also needs P-03. P-07 bSDD tools need the qualified P-06 adapter or an explicit unavailable capability, rather than a second bSDD implementation. The P-08 scorer can be qualified before P-07; recorded agent replay waits for P-07. P-05/P-09 remain unimplemented charters, with their duplicate PRs closed and source branches retained. P-10/P-11/P-12 remain separate preserved work; do not absorb their implementation into these PRs.

## Validation and integration sequence

1. Capture the current remote head and base, unresolved review threads, changed files, published API/changesets and the work log. Compare feature commits with the actual pitch base; merges of main can otherwise appear to be pitch implementation. Read the workflow and ruleset now, rather than replaying historical CI failure descriptions.
2. Reserve a bounded CPU cohort with campaign root. During another owner's measurement reservation, prepare source reviews, fixtures and plans only. Use ext4 for both the isolated checkout and its Git metadata. Do not install/build or run a full test suite beside a benchmark.
3. After admission, run tests through root `pnpm test` with reviewed Turbo filters for the affected packages and their dependencies. Run full root `pnpm typecheck`, retaining both postchecks, plus the touched source/API/docs gates. Build the workspace siblings required by the actual Turbo graph. Package-local scripts are not qualification evidence.
4. Replay meaningful mutation controls against the same source head; record failed baseline assertions, corrected results and restoration. A missing-module load failure is inconclusive. A maintainer exemption may address that structural oracle result only after reviewing the surgical evidence; it does not waive functionality.
5. Keep local source qualification distinct from hosted CI. Feature-base PRs currently have no `test.yml` lanes. Qualify foundations against current main and land them in dependency order; then retarget and normally merge main into dependent branches. If a combined integration candidate is needed sooner, coordinate one candidate with root and preserve each pitch's accountability. Do not weaken workflow branch guards or treat the review signal alone as full CI.
6. Gather behaviour evidence where claimed: real-model Studio screenshots and supersession checks, public-source provenance for bSDD, corpus/oracle results for engine changes, scripted model traces for agent changes. Agent tests must not call live providers or require secret keys. Human review of evaluation descriptions remains separate from executable scorer agreement.
7. Update the pitch work log and unchecked acceptance before changing draft state. Answer every existing review question with the relevant evidence. A partial pitch may be split by its accountable owner into a bounded deliverable; do not silently redefine its acceptance to merge it.

## Cross-pitch contracts to reconcile

- **P-01/P-08 audit pin:** #7149 pins 18 valid corpus cases as `AUDIT_FALSE_POSITIVES`; #7171 states it corrects them. Empty the pin only with the qualified P-01 correction integrated, and rerun corpus/scorer agreement. Do not simply delete a failing assertion.
- **P-02/P-06 ops:** the umbrella vocabulary is a design, not proof every listed op exists. P-06 adds actual `facet.setUri` and snapshot-based `bulk.fromBsddClass` plus GATE-BSDD-001. Reconcile their precise payloads and warning semantics in the architecture document with the source change, so P-03/P-07/P-11 consume one contract.
- **P-03/P-07 supersession:** P-07 deletes `IdsDraftReview.tsx` and `IdsSpecificationEditor.tsx`. Inventory their import/edit/review/save behaviour and prove the replacement covers it before accepting deletion. A source grep or a prompt that says “ops only” cannot establish behaviour.
- **P-04 policy:** the submitter's questions about writable suppressions, noisy ENT-003/SPEC-008 defaults and CARD-001 severity remain unanswered. Preserve current behaviour while the owner resolves them; do not introduce product defaults during recovery.
- **P-08 limits:** all E2 cases remain `reviewed: false`; E3 human gold data, train/validation/test partition, live/recorded runner and benchmark publication remain unfinished. D4 keeps the external benchmark unusable for publication until clarified. A 307/307 scorer self-check is not an AI success rate.

## Completion of this recovery step

This step ends with preserved source, explicit dependency order, a registered next owner for each active branch, and concrete admission/validation plans. Implementation acceptance ends only when each pitch's own “Done means”, unresolved reviews and current-head CI are satisfied. This document adds no new user-visible feature claim.
