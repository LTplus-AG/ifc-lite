# Italian shard 3 independent review

Repairs required. Preserve accepted text except for the concrete repairs below.

Requested base: `07cb9402a9`. Observed parent HEAD: `37b6087cd43bccf33a7cbb9a5d700450ab1ce6d9`. Italian modules are shared uncommitted inputs; the companion JSON records their SHA-256 hashes.

## Scope and evidence

Read root/viewer AGENTS, fleet policy, ACCEPTANCE.md and shard-3-notes.md. Scope is the 53 modules in shard-3.json. Compared actual English/Italian module objects: 3,419 keys, including 137 plural entries; no missing/extra keys or placeholder differences in strings or one/other/many branches. Italian Intl selection was checked at 0, 1, 2, 1.5 and 1,000,000 (other, one, other, other, many). This is a lightweight structural comparison, not a test-suite or runtime acceptance claim. Semantic review targeted conditions, negation, consequences, counts and caller composition. It is not an exhaustive rendered-string certification.

## IT-S3-ASTRA-001 — Reverting an applied edit is described as restoring that edit

Severity: medium.

The shared-room refusal says “prima di ripristinare una modifica”. Its object is the already-applied edit, whereas revertChangeOperation reverses that edit through undo or an inverse. Restoring the edit implies the opposite operation. The standalone Ripristina label and permission text leave the restored object unspecified.

- `changesPanel.revertSharedRoom` (apps/viewer/src/i18n/locales/it/changes-panel.ts:20): EN "Leave the shared room before reverting an edit. The room cannot sync this reversal yet." → IT "Esci dalla stanza condivisa prima di ripristinare una modifica. La stanza non può ancora sincronizzare questo ripristino."
- `changesPanel.revert` (apps/viewer/src/i18n/locales/it/changes-panel.ts:16): EN "Revert" → IT "Ripristina"
- `changesPanel.revertPermission` (apps/viewer/src/i18n/locales/it/changes-panel.ts:19): EN "Turn on Edit mode or ask for editing access before reverting." → IT "Attiva la modalità Modifica o chiedi l'accesso in modifica prima di ripristinare."

Caller evidence: apps/viewer/src/components/viewer/ChangesPanel.tsx:58; apps/viewer/src/lib/changes/revert-change-operation.ts:69

Repair: `changesPanel.revertSharedRoom`: Esci dalla stanza condivisa prima di annullare una modifica. La stanza non può ancora sincronizzare questo annullamento.

`changesPanel.revert`: Annulla modifica

`changesPanel.revertPermission`: Attiva la modalità Modifica o chiedi l'accesso in modifica prima di annullare la modifica.

Recheck: Exercise the shared-room refusal and a successful reversal of an already-applied edit; confirm wording describes removing the edit, retaining newer unrelated edits. Keep revertUnavailable and revertUnsupported unchanged.

## IT-S3-ASTRA-002 — Assistant navigation says Flow while the completed destination panel says Flusso

Severity: medium.

The notes assume Flow is retained as a fixed product name. Actual completed flow-panel.ts has flowPanel.title = Flusso; viewerShell.chunkLabel.flowPanel already agrees with that title. Users following “Apri in Flow” reach “Flusso”. This is an observed label disagreement, not an inference from CamelCase.

- `flowAssistant.openFlow` (apps/viewer/src/i18n/locales/it/flow-assistant.ts:30): EN "Open in Flow" → IT "Apri in Flow"
- `flowAssistant.openFlowToRun` (apps/viewer/src/i18n/locales/it/flow-assistant.ts:62): EN "Open Flow to run" → IT "Apri Flow per eseguire"
- `workflowFlow.title` (apps/viewer/src/i18n/locales/it/assistant-reuse.ts:8): EN "Save workflow as Flow" → IT "Salva il workflow come Flow"
- `assistantReuse.openGraph` (apps/viewer/src/i18n/locales/it/assistant-reuse.ts:78): EN "Open in Flow" → IT "Apri in Flow"
- `viewerShell.chunkLabel.flowPanel` (apps/viewer/src/i18n/locales/it/viewer-shell.ts:18): EN "Flow panel" → IT "Pannello Flusso"

Caller evidence: apps/viewer/src/components/viewer/assistant/WorkflowFlowSave.tsx:117 opens panels.openInHome('flow'); apps/viewer/src/components/viewer/flow/FlowPanel.tsx:189 renders flowPanel.title.

Repair: Preserve the accepted destination title Flusso and Pannello Flusso. Use Apri in Flusso / Apri Flusso per eseguire for these links, Salva il workflow come Flusso for the heading, and align other explicit references to that destination in assistant-reuse and flow-assistant. Do not change .flow.json or runtime graph names. Coordinator should reconcile any other completed destination references once, without rewriting unrelated text.

Recheck: Open the saved graph through the assistant link and compare its text with the actual panel header. Cross-feature evidence is read-only; no request to modify the other shard.

## IT-S3-ASTRA-003 — Copy summary produces su il piano di origine and a plural noun for a single copy

Severity: low.

The copy branch sets count = 1 and substitutes sourceStorey when before.storeyName is absent. The literal composition is “1 nuove copie radice · … · su il piano di origine”. The uncontracted su il is an Italian composition defect. The singular count with plural copies is inherited from the non-plural English template, but remains incorrect in Italian.

- `modelAuthoring.copied` (apps/viewer/src/i18n/locales/it/model-authoring.ts:42): EN "{count} new root copies · {placement} · on {storey}; native hosted fillings and assembly parts travel with their root." → IT "{count} nuove copie radice · {placement} · su {storey}; i riempimenti ospitati nativi e le parti di assemblaggio seguono la loro radice."
- `modelAuthoring.sourceStorey` (apps/viewer/src/i18n/locales/it/model-authoring.ts:46): EN "the source storey" → IT "il piano di origine"

Caller evidence: apps/viewer/src/components/viewer/actions/authoring-row-summary.ts:101-108

Repair: `modelAuthoring.copied`: Nuove copie radice: {count} · {placement} · piano: {storey}; i riempimenti ospitati nativi e le parti di assemblaggio seguono la loro radice.

Recheck: Compose one copy and multiple array copies, both with a runtime storey name and with the fallback. Keep runtime names unchanged and retain sourceStorey as il piano di origine; the colon-labelled repair handles both without a caller change.

## Accepted checks and decisions

- Activity-tray partial cancellation/failure correctly leaves applied edits annullabili; do not rewrite it. Flow review correctly distinguishes restored completed nodes from rerunning them and retains the no-new-request consequence.
- Semantic-assist IDS skipped-model branches preserve {count} as a quantity, including singular. Reexamination refusal strings retain the specific reasons a passing result cannot confirm a fix.
- Linked records help matches actual semantic.title = Record collegati, assistant.title = Assistente, and semantic-identity controls exactly. Data Connector dialog title is Importa dati esterni. Lists title is Elenchi; Ideas is Idee; settings sections are Prestazioni and Privacy. Lente is the singular panel title, whereas Lenti in contentStorage names saved artifacts: no defect established from that distinction.
- BYOK fragments match the fixed JSX ordering around localStorage and Create Key; retain those tokens. ResultView accepts runtime source names, so Risultati di {source} does not establish a gender defect. Do not translate the supplied source names.
- ionUpload.failed receives a translated phase ending in an ellipsis; its phase followed by operazione non riuscita preserves the failure meaning. No repair demanded.
- Keep explicit IFC/schema tokens, file formats, runtime names and model values. No broad CamelCase detector, numerical quality score or native-speaker claim was used.

## Gaps and handoff

Full eager/lazy runtime inventory remains pending shard 1. No GPU/WASM/browser, wide/narrow accessibility, IDS download, negotiation, persistence, root Turbo or lint checks were run. Caller inspection was targeted, not exhaustive across 3,419 keys. This report cannot close whole-campaign acceptance. After the coordinator applies the repairs, obtain a fresh independent recheck; retain all other accepted text.

Only REVIEW-SHARD-3-ASTRA.md and REVIEW-SHARD-3-ASTRA.findings.json were written. No catalogue/test edits, staging, commits, push, delegates, or changes to German/French/old campaign or parent files.
