<!-- SPDX-License-Identifier: MPL-2.0 -->
# Italian shards 2–3 fresh recheck

original five repairs accepted at source-review level; new harness defects remain; runtime acceptance pending.

Base `07cb9402a9`; observed HEAD `36cc7e7f2b8c38a1d7820fab6680abba285f7754`. This is a bounded recheck against both original Astra reports and their companion JSON findings, ACCEPTANCE.md, root/viewer instructions and actual callers. Preserve accepted text.

## Original findings

### IT-S2-ASTRA-001 — accepted

**Cancellation regression uses Italian reversal semantics** — `apps/viewer/src/i18n/italian-catalogue.test.ts:116`

Assertions require “500 di 1000 entità” and “Annulla annulla le modifiche già applicate”, and reject “ripristina le modifiche già applicate”. The actual bulk-property-editor.ts:113 message matches. Bounded catalogue composition confirmed the 500/1000 output. Root test execution pending.

### IT-S2-ASTRA-002 — accepted

**Mounted IDS regression added** — `apps/viewer/src/i18n/italian-ids.test.tsx:37`

Parses inline IFC4 with IFCWALL #10, FireRating F30 and a real IDS requiring F90; validateIDS produces the report consumed by mounted SpecificationCard. Expands specification and requirement, asserts Italian status, requirement and actual failure prose, preserves Wall A-01/GlobalId/IfcWall, then switches to English and revalidates. Existing service synchronization test retained. This is real parser/validator fixture coverage in source, not a mock-return test; execution through root Turbo remains pending.

### IT-S3-ASTRA-001 — accepted

**Revert action direction corrected** — `apps/viewer/src/i18n/locales/it/changes-panel.ts:16`

Label is “Annulla modifica”; permission says “prima di annullare la modifica”; shared-room refusal says “prima di annullare una modifica” and “questo annullamento”. These describe reversing the applied edit. No runtime reversal/refusal exercised in this recheck.

### IT-S3-ASTRA-002 — accepted

**Assistant destination references agree with Flusso** — `apps/viewer/src/i18n/locales/it/flow-assistant.ts:30`

openFlow is “Apri in Flusso” and openFlowToRun is “Apri Flusso per eseguire”; assistant-reuse.ts:8 title is “Salva il workflow come Flusso”, :78 openGraph is “Apri in Flusso”. Other explicit destination references in both modules agree. Accepted flowPanel.title and viewerShell.chunkLabel.flowPanel remain Flusso/Pannello Flusso; runtime {name} placeholders remain. Direct catalogue probe confirmed both open-link compositions. No navigation executed.

### IT-S3-ASTRA-003 — accepted

**Copy summary handles count and fallback composition** — `apps/viewer/src/i18n/locales/it/model-authoring.ts:42`

“Nuove copie radice: {count} · {placement} · piano: {storey}; …” composes correctly for counts 1/3 and runtime “00 groundfloor”/fallback “il piano di origine”. All four bounded compositions checked; English/Italian placeholders exactly count, placement, storey. authoring-row-summary.ts:101-108 passes count=1 for copy or op.count-1 for array and retains before.storeyName. The regression covers both counts and both names. No authoring operation executed.

## New concrete defects

### IT-RECHECK-001 — remaining (P2)

**Wrong exact IDS library delete locator** — `tools/localization-italian/workflow.mjs:94`

The expected button is “Elimina il controllo”. DefinitionLibraryToolbar.tsx:65 renders validationPanel.library.delete, whose accepted Italian value is “Elimina controllo” (validation-panel.ts:104). “Elimina il controllo” belongs to manualValidation.item.remove, a different control.

Change only the harness locator to the actual accepted library label. Otherwise ids-findings-export times out before reaching its JSON export assertions. Verify the corrected path in the required real browser run.

### IT-RECHECK-002 — remaining (P2)

**Narrow acceptance can pass without accessible Italian controls** — `tools/localization-italian/workflow.mjs:117`

narrow-layout records screenshot/body/ARIA and checks only document.scrollWidth <= innerWidth. It never requires a visible or accessible Italian control at 390px. A blank or control-free narrow view satisfies this check; saving an ARIA snapshot does not inspect it. ACCEPTANCE.md explicitly requires wide/narrow accessible labels.

Add concrete narrow-layout accessible-name and visibility assertions for expected controls, exercising the responsive UI as needed. Keep screenshots and ARIA evidence, and do not count artifact existence alone as accessibility acceptance.

### IT-RECHECK-003 — remaining (P2)

**Renderer-health assertion misses Italian failure headings** — `tools/localization-italian/workflow.mjs:51`

The negative pattern is /graphics device was lost|could not recover|WebGPU indisponible/. Italian viewport-lighting.ts:9 says “WebGPU non disponibile”; :74 says “Rendering 3D non riuscito”, rendered by Viewport.tsx:1514 when initError is present. A bounded regex probe confirms both Italian headings escape the assertion. A successful WASM response and loaded mesh state do not themselves prove successful drawing. This is a deficient health assertion, not evidence that this browser run failed or passed.

Assert absence of the actual Italian failure UI (and retain the real English device-loss notifications that still exist). Validate renderer health in the admitted browser run; preserve accepted catalogue text.

## Strict verdict and page errors

Direct read-only Node probe: complete acceptance accepted; empty, missing, duplicate, unknown, extra, fail, skip, skipped, pending, empty status, inspection, missing mode/checks/errors and fatal rejected. Separate EventEmitter pageerror on each of two pages rejected. italian-workflow.test.ts contains the corresponding primary cases. workflow.mjs attaches collectPageErrors to the main page before goto and fresh it-CH page before goto; final verdict runs after context/browser closure. No false-green found in these helper cases.

The inspected Home, Misura, Sezione, Dall’alto (Z), hierarchy search/expand, Validazione dei dati/IDS and export-format strings agree with current catalogue values. This is a textual cross-check, not browser locator certification. The JSON download path really parses the saved file and asserts its source, summary and Italian requirement descriptions; those assertions remain unexecuted.

## Limits and probe record

- Browser/GPU/WASM workflow not executed; no screenshots, real download, accessibility or runtime acceptance inferred.
- Viewer tests, root Turbo graphs, typecheck, lint and pre-handoff were not run, as directed. Mounted test source accepted; its execution is pending.
- Review1 and identical-exception work excluded and untouched; no whole-Italian acceptance.
- Source is shared and dirty; hashes identify reviewed inputs. No staging, commits, delegates or edits outside these two reports. Parent French/German/campaign modifications untouched.
- Catalogue composition probe printed all expected outputs, then its English-object reader failed on the as-const syntax. Corrected bounded reader subsequently confirmed exact English/Italian copy placeholders. This probe failure was tooling-only and is not recorded as a suite pass.
- Fleet status: Pop and PC reachable; Mac disabled. No heavy reservation used.

Current reviewed-file hashes are in the companion JSON. Only the two requested reports were written.
