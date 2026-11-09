# Independent Italian review — shard 1 (Astra)

Review source: HEAD `37b6087cd43bccf33a7cbb9a5d700450ab1ce6d9`, actual campaign base `07cb9402a9`, with the shared uncommitted Italian catalogue. Read root/viewer AGENTS, fleet policy, ACCEPTANCE.md and all three translator notes. No delegates.

**Changes requested.** Three concrete semantic/navigation findings remain. All 422 identical entries were individually reviewed and accepted with exact value pins and contextual reasons in `apps/viewer/src/i18n/locales/it-identical.json`. No illegitimate copy was identified in that set; no broad English fallback or CamelCase heuristic was used.

## Findings

### IT-S1-ASTRA-001 — Help names a lens that does not exist under that name

The instruction directs Italian users to Per fase, while the preset card displays the literal runtime name By Stage. This is model/preset content, not a catalogue-owned label.

- `apps/viewer/src/i18n/locales/it/bulk-property-editor.ts:9`: `Usa la lente Per fase per visualizzare le assegnazioni.`
- `packages/lens/src/presets.ts:70`: `name: 'By Stage'`
- `apps/viewer/src/components/viewer/LensPanel.tsx:131`: `{lens.name}`

Correction required: Keep the runtime preset name By Stage exact in the instruction. Do not rename the saved preset or introduce a translation promise for runtime model values.

Recheck: Read the resulting help beside the built-in preset card in Italian; the referenced name must match exactly.

### IT-S1-ASTRA-002 — Upper bound becomes an asserted fixed depth

A cap permits a smaller configured limit; fissato states an exact half-thickness limit. The geometry-transfer limitation is materially different.

- `apps/viewer/src/i18n/catalogues/appearance-workflows.en.ts:363`: `the depth limit is capped at half the object’s thickness`
- `apps/viewer/src/i18n/locales/it/appearance-workflows.ts:332`: `il limite di profondità è fissato a metà dello spessore dell’oggetto`

Correction required: Express half the object thickness as a maximum bound, preserving the possibility of a smaller depth limit. Keep the rest of this accepted explanation intact.

Recheck: Compare the corrected clause against the English maximum-bound semantics, including a configured depth smaller than half thickness. This review did not execute scan transfer.

### IT-S1-ASTRA-003 — The same Flow input view has two unrelated Italian names

The assistant proposal and stale-review explanation refer to Player inputs, while the actual toggle and input instructions call the same feature Modulo. The translator notes explicitly disagree about this choice.

- `apps/viewer/src/i18n/locales/it/flow-panel.ts:91`: `'flowPanel.view.player': 'Modulo'`
- `apps/viewer/src/i18n/locales/it/flow-assistant.ts:19`: `Input del Player`
- `apps/viewer/src/i18n/locales/it/flow-review.ts:30`: `Il grafo o i suoi input del Player sono cambiati`
- `apps/viewer/src/components/viewer/flow/FlowPanel.tsx:231`: `view === 'player' renders flowPanel.view.player`
- `apps/viewer/src/components/viewer/assistant/FlowCreateReview.tsx:69`: `doc.inputs.length > 0 renders flowAssistant.createInputs`

Correction required: Choose one user-facing name for this view and its inputs across these messages. Preserve the internal player enum. Coordinate the shard-3 text change with its owner.

Recheck: Compare the Flow toggle, inspector input controls, assistant creation summary and stale-review reason together in Italian.

## Accepted targeted checks

- bulkPropertyEditor.cancelledAfter correctly says reversal of edits already applied. Annulla annulla is awkward but adequate semantically; it does not claim automatic rollback on cancellation. No mandatory stylistic rewrite requested.
- ClashHelp JSX composition preserves increasing gap gives more results, severity is not overlap depth, and touching is approximately zero.
- ScriptPanel sandbox and deletion fragments compose with actual JSX spaces and code tokens; deletion remains irreversible.
- semantic.resourceBindingHelp quotes identityControls/identityUri exactly.
- checkAuthoring.skippedModels counts unchecked models, not their identifiers, in all supplied plural branches.
- changeSets empty/noActive keep Unsaved changes as the literal runtime name.
- IDS required/optional/prohibited clauses preserve applicability and requirement conditions; missing checks do not become successful results.

## Identical entry decisions

Each entry has its own explicit key, exact value and reason. Units and mathematical notation remain exact; IFC EXPRESS attributes and classes, selector/JSON/API syntax, format names, addresses, product names and runtime identity compositions are not translated. Shared Italian words such as Area, Volume, Schema, Base and No are legitimate, as are established technical borrowings used in their actual context.

Less obvious cases were considered explicitly: `idsPanel.audit.facet` labels the IDS category alongside `issue.facetType`, and IDS Studio consistently calls the same concept facet; `extensionsPanels.planCard.fixtureLabel` is beside developer `test.fixture`; InfluxDB Bucket/Measurement name database concepts rather than model quantities. `chatByok.keyModal.walkthroughStep2CreateKey` quotes an external console action, not a local button. These decisions are narrow and do not exempt unrelated prose.

A fresh lightweight read of all 158 English/Italian modules found 10,607 keys each and 422 identical values. The manifest has exactly those 422 keys, no stale/missing entries, matching values and nonempty individual reasons. This check used the installed TypeScript transpiler to inspect catalogue objects; it is not a repository test or typecheck.

## Coverage and limits

All 53 assigned feature modules received risk-based review: paired English/Italian reads of the longest seven messages per feature (all messages for smaller modules), additional selected negation/quoted-name clauses, and targeted caller traces. The machine-readable report records each feature and reviewed Italian file hash. This is **not** an exhaustive reading of all 3,666 shard keys. Do not count it as full semantic acceptance; unsampled text in larger modules remains a coverage gap.

- No mounted/browser/GPU/WASM/model execution. Narrow layout, accessibility output, pageerrors, actual downloads and locale persistence remain parent acceptance work.
- No root Turbo tests/typecheck/lint or heavy graph; this review only validated catalogue/exception data with a lightweight TypeScript transpilation scratch check. It is not typecheck or the repository test suite.
- The initial broad source dumps were truncated; sampled subsequent paired reads and targeted caller reads are the evidence, not an assertion that the truncated portions were reviewed.
- No fresh recheck after parent corrections yet.
- Identical wrapper acceptance does not prove that every interpolated runtime message is localized. Stored model names, schema values and runtime identifiers are intentionally outside translation.

Only these two review artifacts and `it-identical.json` were written. No catalogue translation, other source edit, staging, commit, push, or heavy graph was performed. French, German and old campaign work were left untouched.
