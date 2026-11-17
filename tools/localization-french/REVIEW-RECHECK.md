# French independent semantic recheck

Decision: **accepted for the reviewed semantics and code repairs**. No concrete residual defect found in the requested scope. This is not full release acceptance: root validation and rendered browser evidence remain pending.

Reviewed 2026-11-05 in the shared dirty checkout at HEAD `abeb878ee85cd1b3fd111ffda748473f177e53a3`. Read REVIEW-SEMANTIC.md, ROUNDS.md, ACCEPTANCE.md, the viewer instructions, runtime implementation and affected callers. Only this report was written. No delegation, production edits, staging, commits, regeneration, campaign runs, heavy commands or browser launches. German and existing campaigns were untouched.

## Four findings rechecked

1. **Workflow helper repaired.** `workflow-verdict.mjs` exists and exports both names imported by `workflow.mjs`; its accompanying `.d.mts` describes the actual report and event interface. A bounded runtime probe imported the helper and used two independent EventEmitters: an error from either page was collected and changed an otherwise passing report to failure. Fatal errors and failed checks also failed; clean reports passed. Source inspection confirms collection on the main page and on the fresh fr-CH page before navigation, and the finalizer applies the helper verdict to `process.exitCode`.
2. **Exact exceptions repaired.** Loaded English and French objects produce exactly **536** identical messages, matching the exception key set exactly. All pinned values match and every explanation exceeds 30 characters. `idsPanel.notApplicableCount` is no longer a stale exception; its translated forms remain present.
3. **Change-set promise repaired.** `changeSets.empty` and `changeSets.noActive` describe automatic creation without promising a translated set name. This agrees with `mutation-history-record.ts`, which creates a set when no active target exists. The legacy `Unsaved changes` content name remains outside this bounded repair.
4. **Appearance precedence and controls repaired.** The description now refers to elements common to multiple assignments, and both review labels use éléments. The component consumes those labels for the visible button and accessible name. A direct probe of the real resolver confirmed later-row precedence for the same element, restoration of the earlier assignment when the later row excludes it, and isolation between models. This supports the revised instruction; rendered control behavior is still a browser acceptance item.

## Runtime and regression coverage

Two read-only stdin probes ran with installed `node --import tsx --input-type=module`, both exit 0. They imported actual production modules, without invoking the test runner or any dependency build.

- **10,607 French keys match 10,607 English keys**, including lazy catalogue exports; the existing catalogue validator reports zero problems before and after English feature registration.
- Startup activated French from fr-CH before lazy English registration. Every French key was owned by the active locale, and a lazy retained-geometry message resolved in French. URL choice persisted, a fresh activator reused saved French, and `?lang=en` switched back; the supplied HTML-language object followed each choice.
- **466 plural messages** were resolved at 0, 0.5, 1, 1.5, 2, 2.5 and 1,000,000. Selected forms matched French Intl categories, non-count context sentinels survived, and no named placeholders remained unresolved. Element summaries resolved to `0 élément`, `1 élément`, `2 éléments`, and `1000000 d'éléments`. This establishes plural selection, not localized fractional-number display.
- `semanticAssist.idsSkipsModels` resolves to “Le brouillon IDS ne vérifie pas 2 modèles chargés…” for count 2. Its caller passes `loaded.unchecked`, which increments once per unsupported/unknown model schema, and displays the warning only for a positive count. It denotes a number of unchecked models, not an identifier. Singular and million-count forms also resolve correctly.
- A bounded IDS-sync probe confirmed French propagation, preservation of an explicit IDS choice on catalogue-only notification, and propagation on a subsequent viewer-language change.
- `french-workflow.test.ts` exercises the real helper with event emitters, including errors from each page and fatal/failed-check verdicts. Wiring is present through the existing graph: root `pnpm test` invokes `scripts/test-cache.mjs`, which launches Turbo test; the viewer test script discovers `src/**/*.test.ts` and `.test.tsx`, including this file; Turbo forwards TEST_PATTERN and shard selectors and retains the build dependency. Viewer typecheck includes this source and the helper declaration is present. **The regression test and typecheck were inspected, not executed through the root graph in this recheck.**

## Evidence still required

The coordinator must supply stable-source root pnpm/Turbo typecheck/tests and applicable gate results, with host, command, receipts and skips. This review provides no replacement for them.

Real committed IFC/IDS GPU workflow acceptance remains pending: loaded/rendered geometry, hierarchy and properties, measurement, section, French IDS findings and export, narrow/wide screenshots and accessible controls, reload/URL/browser negotiation, and page-error collection on both contexts. No browser evidence was produced or accepted here. These are outstanding acceptance obligations, not additional semantic defects. This bounded technical review is not native-speaker approval or a claim to have manually reviewed every sentence.
