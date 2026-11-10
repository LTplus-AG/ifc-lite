<!-- SPDX-License-Identifier: MPL-2.0 -->
# Independent Italian shard 2 review

Changes requested in coordinator tests. This is a partial review, not campaign acceptance. Reviewed at HEAD `37b6087cd43bccf33a7cbb9a5d700450ab1ce6d9`; handoff base remains `07cb9402a9`. No catalogue/test edits, staging, commits, pushes, delegates or heavy graphs. German/French translations were not used as sources; parent changes and old campaign trees were preserved.

## Findings

### IT-S2-ASTRA-001 — regression-test-language (P1)

`apps/viewer/src/i18n/italian-catalogue.test.ts:116`

**English / requirement:** bulkPropertyEditor.cancelledAfter: Cancelled after {done} of {total} entities. Undo reverts the changes already applied.

**Italian / implementation evidence:** The test registers it and selects it, but asserts /500 entités sur 1000/ and /revenir à l’état précédant les modifications déjà appliquées/. These are French assertions inside the Italian regression test. The bulk-property-editor catalogue belongs outside shard 2 and was not reviewed.

**Impact:** Correct Italian cancellation guidance cannot pass this regression. The test does not enforce the requested Italian Undo meaning.

**Correction:** Assert Italian resolved output with done=500 and total=1000 and wording that reverses already-applied edits, e.g. Annullato dopo 500 entità su 1000. Annulla riporta allo stato precedente alle modifiche già applicate. Do not use ripristina le modifiche già applicate, which would restore the edits. Update the regression attribution without editing the French tests.

**Verify:** Run the corrected Italian test through the authorized root Turbo selection after source stabilizes; verify the assertion rejects wording that restores already-applied edits.

### IT-S2-ASTRA-002 — missing-rendered-regression-coverage (P2)

`apps/viewer/src/i18n/italian-ids.test.tsx:13`

**English / requirement:** ACCEPTANCE.md requires IDS Italian synchronization and rendered findings.

**Italian / implementation evidence:** The sole test checks service().t(status.fail) === NON CONFORME and describeFacet(...IFCWALL...) contains IFCWALL. It never mounts a findings component or checks visible Italian description text.

**Impact:** The test can pass when a findings component renders English, ignores idsLocale, or is not mounted. The IFCWALL-only assertion would also pass for an English description. This is a coverage defect, not evidence of a shipped rendering defect.

**Correction:** Add a mounted IDS findings regression with a real validation report/fixture. Assert visible Italian status and requirement/failure text, preserve IFC identifiers/model values, and verify English switching. Keep the existing synchronization test.

**Verify:** The rendered regression should fail if the findings UI uses English despite Italian startup; browser acceptance must independently exercise Italian findings and parsed JSON export.

## Scope and observations

All 52 shard-2 English/Italian module pairs were included in the structural inventory: 3,522 keys and 148 plural objects. Semantic inspection focused on warnings, actions, conditions, negations, plural branches, technical literals and selected composed labels. Exact reviewed-file hashes and the module list are in the companion JSON. This does not claim exhaustive mounted verification of every label.

The read-only catalogue probe found no placeholder mismatch and no missing one/other/many branch. No broad English prose copy was identified in the exact-equality inventory. Numeric counts above describe scope, not translation quality.

Concrete caller checks: `DryRunResults.tsx:44` passes `run.skippedModels.length`; Italian says “{count} modelli caricati … non sono stati controllati”, a quantity, not an ID. `DocumentOutlineReview.tsx:42` passes the row-mode token `block.rows`; “modalità {rows}” preserves that distinction. `run-reconcile-clash.ts:123` counts cross-revision pairs, so “coppie tra revisioni” is supported and was not flagged. `mutation-history-record.ts:21` defines the literal saved name “Unsaved changes”; retaining it in quoted Italian guidance does not promise translation of saved model content.

Canonical tokens were examined explicitly (see JSON), not inferred from capitalization. Standard property examples such as FireRating and STEP literals remain distinct from translated explanatory prose. English and Italian geometry-export guidance preserve SurfaceColour versus a distinct DiffuseColour RGB value.

The workflow verdict uses exact expected-set length, uniqueness, required-name membership and all-pass status; inspection cannot pass. A direct Node probe confirmed these rules and rejection of page errors from either of two emitters. This is helper evidence only, not a browser run. The declaration matches the helper contract. README integration documents the Italian entry point, glossary, plural categories, persistence and maintenance tests without adding a loading path.

The Italian IDS test proves service synchronization only; its missing rendered coverage is IT-S2-ASTRA-002. The cancellation message itself is outside this catalogue shard, so IT-S2-ASTRA-001 concerns only the coordinator test, not an inferred defect in unfinished translation.

## Gaps and required recheck

- Shards 1 and 3, their unfinished catalogue text, and the all-locale composition are outside this review.
- Semantic review prioritised complete warnings, actions, conditions, negations, plural objects, technical literals and selected composed labels across all 52 modules. This is not an exhaustive mounted review of every short label or every caller.
- No root Turbo tests, typecheck, lint, heavy build, GPU/browser run, real IFC workflow, export inspection or post-commit handoff ran. The moving catalogue is not accepted.
- The workflow helper and its emitter tests are sound in the exercised cases; no Italian browser workflow driver was present in the inspected tools directory. Actual listener attachment on both browser pages remains unverified.
- The value-pinned it-identical.json integration and whole-catalogue startup ownership must be checked after the remaining shards finish.
- A fresh independent recheck is required after corrections and remaining-module review.

Fleet at review startup: Pop reachable with existing running/queued jobs; PC and Mac disabled. No reservation was needed for these read-only catalogue/helper probes.

After fixes, recheck the two findings against fresh file hashes, review remaining modules separately, then run stable-source root validation and the real two-page hardware-GPU acceptance workflow. Preserve the original handoff base.
