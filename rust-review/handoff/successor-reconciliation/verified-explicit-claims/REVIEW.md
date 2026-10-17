# Verification of five explicit stale-open fix claims

This is a derivative evidence reconciliation, not a replacement ledger or a bulk-close instruction. The immutable archive remains pinned at `7a44f548f67a7e57f510ecf0e79150267a4a7971`; the original CSV still records all five IDs as open. Only these five IDs/four existing fix PRs were examined. Current source was read at `aca9452d04cd095ffc58141b4ad487655e77f133`, without editing the frozen checkout, starting claims or modifying active C6/F4 work.

**Result:** the original schema-route disagreement (two IDs) and derived-context panic have supported fixed-by mappings. The energy relative-precision fix is supported, with the original origin-loss observation retained for an explicit scope decision. SERVER-26's output-row cap is supported, but a previously reported pre-budget allocation mechanism survives current main, so the whole resource-bound finding must remain partial.

## Disposition summary

| Original ID | Fix PR / exact merged commit | Verified scope | Whole-ID qualification |
| --- | --- | --- | --- |
| PROCESSING-5 | [#7727](https://github.com/LTplus-AG/ifc-lite/pull/7727), `406957e683b7d27234565f4ec16194a7147fe3e2` | One metadata schema detector; declared lowercase schema wins; DATA/GUID decoys cannot override a valid declaration; cache namespaces invalidated | Original reported route-parity defect covered. No new pending acceptance identified within that class. |
| SERVER-18 | Same PR/merge | Same server `/parse/metadata` versus `/parse` defect | Covered for metadata parity. Do not reinterpret this as deletion of raw-label preservation APIs or registry-layout selectors; those have distinct contracts. |
| PROCESSING-APP-2 | [#7725](https://github.com/LTplus-AG/ifc-lite/pull/7725), `2d5333ff92026401fea57bc9ba47a60f734f6c97` | Shared-body derived-context input is excluded; file attribute writer is total | Original panic plus requested attr-0 guard covered. Direct release-abort wasm execution of this exact case is not established here. |
| EXPORT-DATA-6 | [#7738](https://github.com/LTplus-AG/ifc-lite/pull/7738), `d8c110166a07e494be45e509e31db2c614b31217` | f64 world transforms through HBJSON/DFJSON rebase; rooms, Room2Ds, window and railing relative positions | Relative-precision defect covered. Absolute origin is still discarded by DFJSON; original “consider emitting the origin” suggestion needs an explicit scope/debt disposition, not an automatic full georeference claim. |
| SERVER-26 | [#7718](https://github.com/LTplus-AG/ifc-lite/pull/7718), `932c7db80a485ee877ca7cbd4b3fee140825726a` | Shared output-row byte cap, explicit refusal/error path, ordinary-row control | **Partial.** Resolved layers and their owned strings are fully allocated before the first output-row budget charge. Existing final-head review already reports this class. |

Machine-readable `dispositions.json` and `dispositions.csv` separate verified subparts, pending acceptance, scope observations, exact source pins and historic validation limits. The conservative whole-ID flag for EXPORT-DATA-6 preserves a scope question; it does not authorize a new georeference feature. No optional/debt item is marked closed by eligibility or a merged issue alone.

## PROCESSING-5 and SERVER-18

Original anchors: `05-processing.md:73–81` and `08-server.md:242–253` in the immutable archive; verbatim extracts are in `original-findings.md`. Both report the same concrete defect: server and processing independently sniff schemas and disagree on lowercase headers and valid IFC2X3 headers with IFC4X3 text in DATA. SERVER-18 also lists the exporter reader/default as surrounding architecture.

Merged #7727 deletes the server's private detector/find_bytes and routes metadata through the public processing function. Its final detector uses the quote/comment-aware shared FILE_SCHEMA selection, with ASCII case-insensitive family recognition and a documented fallback only when no identifier is recognised. On current main, the metadata route calls it at `apps/server/src/routes/parse/json.rs:289`; native metadata calls it at `rust/processing/src/processor/mod.rs:476`; `schema_detection.rs:28–29` delegates to the later C6 `SchemaFamily::detect` home. `rust/core/src/schema_family.rs:79–84` still gives declared schema precedence. Thus current source preserves the concrete parity correction rather than merely containing the merged PR in history.

The real HTTP regression remains at `apps/server/src/parity_tests.rs:759–782`: it uploads both lowercase-header and valid IFC2X3/DATA-decoy controls to `/api/v1/parse/metadata` and `/api/v1/parse`, checks success and asserts both schemas against the expected declaration. Processing's shared-vector and GUID-decoy tests remain at `schema_detection_tests.rs:16–40`.

The [final owner delta review](https://github.com/LTplus-AG/ifc-lite/pull/7727#issuecomment-6213218679) reports:

- per-detector production mutation makes the shared-vector/GUID tests and the HTTP decoy parity case fail;
- reverting cache-key bumps makes 27 server cases fail; the reviewer audited every schema-carrying cache payload;
- 122/122 real corpus fixtures agree between Rust and TS, including the two actual IFC2X3 models previously mislabeled from IFC4 text inside GUIDs;
- a green local full gate on final branch head `56edae01be18bfb6188a00f8834a6c03ff459835`, including workspace tests, parser suite, oracle and wasm contract.

These are cited historic runs, not rerun measurements. The review contains non-blocking header-selector/vector/Unicode nits; its claim is not that every possible schema API has one default. Current core explicitly separates family classification from registry layout and has caller-selected defaults (`schema_family.rs:10–16`). Export's `schema_detect.rs:13–16` reads the raw declared label through the shared header reader to preserve source headers, with IFC4 fallback. Its continued existence does not recreate a second server metadata producer, and this review does not decide wider C6 architecture policy.

With no usable declaration, the first-2000-byte fallback may still match GUID/DATA text. That is explicitly documented and differs from the original valid-declaration failure. No fresh runtime proof on current main was produced.

## PROCESSING-APP-2

Original anchor: `05-processing.md:610–618`. The actual path is evaluatedOccurrence planning over a shared Body wrapper whose ContextOfItems is file-supplied `*`, then shallow attribute copying into a private wire converter whose wildcard arm panicked. Its proposed fix has two parts: total authored writer reuse and an EntityRef guard on context.

Both exist in the final merged source and remain on current main:

- `appearance/evaluated.rs:7–10,27–30` imports and calls `authored::wire` for copied attributes;
- `authored.rs:55–66` exhaustively handles current AttributeValue variants, including Derived→`"*"` and recursive typed/list values;
- `evaluated_source.rs:37–38` rejects a Body without a ContextOfItems EntityRef before replacement;
- `evaluated_tests.rs:373–392` exercises real `plan_appearance` over parsed STEP with a type-shared Body. A valid context converts and clones the representation; `*` yields one explicit context exclusion and no conversions/created/edited rows.

The [first owner adversarial review](https://github.com/LTplus-AG/ifc-lite/pull/7725#issuecomment-6209172203), at `e317f599b5`, reports the processing regression red at evaluated.rs:30 on production revert and green restored, and explicitly confirms both APP-2 fix parts. The final PR body retains that test and base-panic evidence. Its real wasm contract witnesses concern other S5 cases; do not relabel those as direct wasm evidence for APP-2.

The latest captured owner review at `033889804c` is changes-required over release metadata and separate kernel concerns. The immutable archive ledger:137 records the eventual merge and main's 4834 passing tests. Neither fact is an independently observed final runtime result here. Those earlier review commit objects are absent locally; the attempted exact review-to-merge diff limitation is recorded in `review-to-merge-comparison.json`. Final merged and current APP source/test bodies were inspected directly. No remaining APP-2-specific acceptance was identified; broader APP-1 converter consolidation is separate.

## EXPORT-DATA-6

Original anchor: `07c-export-data-model.md:75–87`. It identifies f32 world translation before export rebasing, including rooms/openings/shades, misleading precision documentation, and an observation that DFJSON throws away the origin. The Fix says to preserve f64 translation/RTC, correct the doc, and **consider** emitting the origin.

The actual precision fix is present at merge and current main: `ExtractedProfile.transform` is `[f64;16]` (`profile_extractor.rs:67–74`), conversion to WebGL world frame keeps f64 (`:469–477`), and `export::geom::xf` reads f64 matrix values (`geom.rs:37–45`). `rooms.rs:8–9,48–61` correctly documents/rebases f64 world coordinates. Local profile points and relative extrusion quantities stay f32, and the JS profile bridge still narrows to its existing Float32Array surface; neither establishes world-placement precision loss on the native energy export path.

The retained real parser/export tests at `issue_7684_energy_precision.rs` cover:

- HBJSON rooms and DFJSON Room2Ds authored 4.1m apart at LV95, with 1mm tolerance;
- a window's start (1.1m) and sill (0.8m);
- a railing post's east/north offsets (4.775m/0.475m).

The [final owner approval](https://github.com/LTplus-AG/ifc-lite/pull/7738#issuecomment-6217157785) is at final branch head `72703c0b214e43b9e190240ca57988648e1f4775`. It reports the four precision cases red under production revert, a 50/50 green oracle baseline and 0/4 reverted precision cases, hand-checked opening/shade values, workspace 4859 passing tests, export parquet-bos 776 passing and wasm contract 204/0/1. The body also records a real duplex golden numeric diff (maximum about4.2e-7m); that is real-model output stability, not a real-authoring-tool national-grid witness. No direct adjacency-result test or fresh current-main run was performed.

**Retained scope observation:** `dfjson/plates.rs:70–71` still binds `(fps, _origin, ...)`. Relative coordinates are precise, but that discarded origin has not become a public absolute georeference in this evidence. Treating the entire ID as a georeference-round-trip fix would overclaim. Since emission was phrased as “consider,” the correct pending step is an explicit scope/debt disposition, not silently requiring a new feature or dismissing the observation. Keep archived issue7684 provenance and the actual #7738/#7690 fix association.

## SERVER-26

Original anchor: `08-server.md:329–337`. The defect is element×layer amplification with file-supplied strings causing memory exhaustion, and one proposed solution is a global explicit row refusal.

#7718 implements the output-row solution: at its merge, materials.rs:340–356 resolves layers and then charges the model-wide `max(16×input,16MiB)` byte budget before building output rows. Current main moved the implementation to `rust/processing/src/data_model/materials.rs`. `:366–368` still gates row creation at370. Explicit DataModel refusal propagation/serialization/fetch handling remains; the original regression and ordinary12-row control remain in `data_model/tests.rs:2867–2900`. Existing test names/inspection establish behavior intended, not a new test execution.

The [first owner review](https://github.com/LTplus-AG/ifc-lite/pull/7718#issuecomment-6204237829) measured no refusal and byte-identical outputs over121 corpus fixtures; maximum use was1.16%of budget. Its material-charge mutation was observed red with an attributable green baseline. A [later review](https://github.com/LTplus-AG/ifc-lite/pull/7718#issuecomment-6211867307) confirms refusal→400 and streamed-refusal fetch behavior. Later changes-required rounds largely concern separate complex-property semantics. They cannot prove allocation preceding the material-row charge is bounded.

**Actual residual, already reported:** [final-head inline review discussion_r4295809813](https://github.com/LTplus-AG/ifc-lite/pull/7718#discussion_r4295809813) identifies resolved-layer string multiplication before the charge. This is also the mechanism in current main:

1. `extract_materials` calls `resolve_material` at357 inside the scale-cache initializer; that call must return a full Vec before row bytes are summed at358.
2. `resolve_set` copies the set name once at183, then clones it into every ResolvedLayer at228 and collects the entire iterator at245.
3. Only afterward does `used.fetch_add` at367 test the output-row budget. A refusal there cannot undo memory exhaustion already encountered during collection.

A semantic witness needs only one related real element, one valid material/layer, and an IfcMaterialLayerSet listing that same layer20,000times with a512KiB LayerSetName. The input is roughly600KiB, so the floor is16MiB; owned set-name clones alone are20,000×524,288=10,485,760,000bytes (9.77GiB) before the first refusal check. Multiple parallel relationships can compound intermediate retention. This arithmetic is source-derived, not measured RSS; no OOM probe was run. The same pre-charge clone/collect ordering is present at merged#7718, before the later C6 move/table consolidation.

The existing output-fanout test has a short `'Wall'` name and asserts eventual row count/refusal. It cannot prove a long string is refused before intermediate cloning. Thus whole-ID resource-bound acceptance is **pending**, while the output-row-cap subpart is verified.

A later owner-scoped correction must bound material-definition/resolved-layer allocation before cloning file-sized strings, preserve current within-budget semantics and explicit refusal propagation, and cover this long-shared-name/repeated-member shape with a meaningful fail-early/allocation invariant. Coordinate through the existing data-model lane and existing finding, not a duplicate claim. This report implements nothing. Separate complex-property exporter clone/depth-marker residuals at archive ledger121–122/152 remain outside this five-claim scope.

## Evidence limits and artifacts

- All four exact merge commits are ancestors of the inspected current-main pin; ancestry is provenance, not behavioral proof.
- `pr-*.json` captures targeted read-only live metadata, bodies, issue comments and reviews; `pr-*-inline.json` captures inline discussions. No CI polling occurred. `pr-*-merged.diff` uses each merge's actual first parent rather than a changing main comparison.
- `source-identities.json` pins copied merge/current source by commit, blob ID and SHA256. `review-metadata.json` records exact PR heads/merges/parents and ancestry; `artifact-hashes.json` hashes the supporting evidence files.
- `archived-explicit-claims.json` and `original-findings.md` retain the per-ID claim and original finding boundaries. `dispositions.json/csv` is the only new classification output; original archive and parent draft CSV are unchanged.
- No tests, builds, perf jobs, browser runs, source edits, new claims, GitHub mutations or ref changes were performed. Historic owner-reported tests and current source inspection are explicitly separate from unrun current-main runtime acceptance. Active C6/F4 ownership is preserved.

Public companion includes the scoped review, dispositions and source/review identities. Full local raw PR captures and source copies are omitted; the cited public PR discussions and exact Git commits preserve their primary sources.
