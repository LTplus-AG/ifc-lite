# Generic IfcGroup lifecycle acceptance — #7329

The stack adds one native Create owner for exact generic `IfcGroup` creation, complete membership replacement and removal, then reuses it through the SDK, CLI, sandbox and reviewed viewer transport. It does not broaden Structural assignment/deletion or claim campaign #6812 human acceptance.

The lower PR is #7345; the upper reviewed transport PR is #7346. Their tracked changes are Create/SDK/CLI/sandbox/viewer, guides, changeset and generated API/types. Ordinary main integrations are excluded from their diffs. No perf-sensitive path or throughput claim is introduced.

## Ground truth and public behavior

- IFC4 native controls parse the committed Bonsai-authored `hello-wall.ifc`; viewer controls parse the committed SketchUp-authored `building-architecture.ifc` with the canonical current loaded-model editor/history adapters.
- IFC4X3 controls include native `IfcCreator` output and the separately authored SierraSoft Infra Design Studio/BIM Exchange railway fixture `tests/models/ifc5/Railway_Railway_project_simple_IFC4X3.ifc`, `FILE_SCHEMA(('IFC4X3_ADD2'))`. The manifest pins SHA-256 `1937d5697ce796a9b0ac8c836fbfa42867e970b22b3a3adf0dafe371886a533b`; the normal root fixture fetch verified it. The real railway test preserves Root identities #21/#22, reuses the relationship identity, exports complete replacement, checks every exported STEP reference, and compares every original independently parsed semantic record after removal.
- Native controls cover missing/deleted/duplicate/stale Root identities, duplicate membership, self-assignment, shared incoming assignment, protected incoming dependencies, multiple own relationships, quote-aware references, single-record/total-work bounds and failed first-call allocator preservation.
- Viewer acceptance exercises the actual rich selection and explicit attachment request builders. Provider fetch is intercepted only at the network boundary; supplied response operations are validated against native fixture evidence. The mounted actual answer dispatch reaches selective review, requires explicit acknowledgement, previews without publication, applies the approved native operation, independently parses the exported graph and exercises one receipt Undo.
- Two real parsed loaded sources prove model ownership with identical local IDs, refusal of foreign membership, invalidation after a peer source revision, independent membership exports and one Undo per source.
- The existing authoring test fixture supplies empty geometry and a remesh client that never answers. These receipts establish native IFC metadata/relationship/export/history behavior; they do not establish WebGPU geometry, human semantic labels, privacy/licence approval or coordinator-study results.

Complete semantic preservation comparisons exclude generated export header timestamps by independently parsing every effective entity record. No normalized-header string assertion replaces the graph oracle. An earlier byte comparison produced an incidental timestamp failure; that log is retained separately and is excluded from the accepted counterproof counts.

## Counterproof boundary

The public whole comparison substitutes the five complete current-main `fc27e12d113534b952b1eb430ed0b9b87b3387b6` entrypoints: selection grounding, explicit attachment selection adapter, request guidance, answer dispatch and public store adapter. Newly introduced private native/review helpers remain so genuine native controls can execute. This is a public-route class comparison, not a claim that the new private native API existed on main. It produces five genuine missing public-route assertions and nine passing controls (three native review controls plus six pre-existing graph-oracle controls); exact SHA restoration passes all fourteen. There are no missing-module/import failures.

The mounted dispatch inverse produces thirteen passes/one genuine UI assertion failure; the native-write no-op inverse produces eleven passes/three independent native graph assertion failures. Every restoration passes all fourteen. The total-work ACT inverse removes the limit, and the REPORT inverse silently truncates the graph; each fails the stated work/refusal invariant while the remaining native controls pass. Source bytes are restored and SHA-256 verified in `finally` after every mutation.

The accepted logs and receipts distinguish each inverse, restored run and earlier failed/cancelled attempt. Test counts are read from actual runner output; skips are never counted as passes. The first broad run had optional oracle/fixture skips. The canonical cost fixture was fetched, and the existing read-only Python `/tmp/6516-root-oracle-py312/bin/python` supplied exact pinned IfcOpenShell 0.8.5; `--env-mode=loose` passed this interpreter to root Turbo tests. The repeated broad run executes the formerly skipped controls.

## Acceptance limits

Root typecheck, lint, build, generated API/types, docs and bundle acceptance must complete at the final composed stack head before review readiness. The lower standalone work remains partial (`Refs #7329`); only the upper combined implementation closes #7329. Fresh hosted review/questions and parent review remain merge requirements. This evidence never turns a pending hosted check green or resolves a review question without an answer.

Campaign #6812 human evaluation labels, fixture privacy/licence approvals and coordinator-study results under #6928 remain unperformed in this implementation evidence. Existing fixture provenance and successful technical execution do not substitute for those approvals/results.

## Terminal results before final combined qualification

- Native Group fixture class: 16 passes, zero skips; ACT and REPORT inverses each 15 passes/one invariant assertion failure, followed by 16 restored passes.
- Full Create suite: 1,535 passes (109 files), zero skips. Full SDK suite: 343 passes (33 files), zero skips.
- Composed viewer Group and shared graph-oracle controls: 14 passes, zero skips. Whole current-main and both surgical restorations: 14 passes, zero skips.
- Proper root typecheck: 119 Turbo tasks passed, all 3,860 test sources audited, and final frame-source tsc passed before the last external-fixture test addition. Proper root lint then passed; no warnings were present in any touched file. These earlier terminal checks do not substitute for the final combined all-ten-step qualification at the final committed head.

The accepted semantic production source before evidence-only addition was composed head `ce302d9c16b04eb7fdefb83bfadaff432720999a`. The final combined receipt is recorded separately after the frozen stack qualifies.

## Corrective native assignment semantics after review

Review found that mixed PRODUCT/PROCESS assignments could be consolidated into
one relationship. Generic replacement now refuses any typed RelatedObjectsType
assignment and consolidation of distinct OwnerHistory, Name or Description.
A complete member list cannot express the separate assignment semantics. Reads
and safe removal remain supported. Refusal precedes metadata edits, allocation
and publication; real Bonsai source controls independently parse every exported
entity type/attribute and prove graph, revision and allocator preservation.

Final native class: 19 passes, zero skips. Typed-guard inverse: 17 passes/two
actual refusal assertions fail; distinct-semantics guard inverse: 18 passes/one
actual refusal assertion fails. Exact source SHA restoration yields 19 passes.
Compressed logs, hashes and restoration receipts accompany this correction.
The earlier afff combined all-ten PASS is preserved, but does not qualify this
corrective source head; fresh qualification remains pending.

The initial corrective task fixture had an incorrect twelve-slot IfcTask record;
review caught it before merge. It now uses all thirteen IFC4 attributes, with
mandatory IsMilestone .F. and final PredefinedType .NOTDEFINED. The pinned actual
IfcOpenShell 0.8.5 validates both native regression exports with EXPRESS rules:
zero issues before and after refusal. Native19 and each guard inverse above were
repeated after this correction; their original logs remain preserved.

After ordinary integration of actual main fe3070cfb18853dd857554615160806a607dbae2,
the five actual public-entry whole comparison gives 11 genuine passing controls
and three real provider/request evidence assertions, then exact-SHA restoration
gives 14 passes with zero skips. Main now includes the native foundation; this
is the transport boundary, with private review helpers retained to execute real
controls. It does not reuse the older fc27 five-failure count.

The first corrective broad Create run under concurrent heavy work hit the
unchanged five-second railway test and ten-second mapped-WASM hook deadlines.
Those timeout failures remain recorded; no deadline or acceptance was relaxed.
Broad rerun and new-head all-ten qualification require their actual terminal
receipts and remain pending at this evidence commit.
