<!-- This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Independent adversarial German review

Reviewed source: `0a92c4aadad48d3fb13974a2746f7d3a370f861d` (HEAD during inspection), 2026-11-05. Reviewer: GPT-6 Astra. This is an independent source/caller review with lightweight runtime catalogue probes, not native-speaker approval or browser acceptance.

**Disposition: changes requested.** Four concrete findings below remain at this revision. The cardinal-count/identifier confusion and incorrectly named mapping/filter inputs block accepting semantic fidelity. The composed report-preview message also needs a caller fix; catalogue completeness does not cover it. No startup catalogue-loss defect was reproduced. No severity-one data corruption or inverted destructive-action warning was established.

Read root and viewer AGENTS, fleet policy, and `tools/localization-german/{ACCEPTANCE,REPORT,WORKFLOW}.md`. No delegation, heavy checks, browser session, staging, commit, or queued-request manipulation. The original `auto-0fce1bb98b224ca5af396a9d93a374d4` was neither replayed nor cancelled. Only this review file was written.

## 1. P2 — Singular counts become model/specification/card identifiers

**Locations:** `apps/viewer/src/i18n/locales/de/validation-panel.ts:39`, `check-authoring.ts:48-49`, `semantic-assist.ts:97`, `review-workspace.ts:125,138,140`, and `misc-panels-a.ts:69` (paths after the first are under the same German locale directory).

These are quantities, but the German singular moves the number after the noun and adds a definite article, identifying a particular numbered object instead:

| Key, with numeric `count: 1` | Actual runtime result |
| --- | --- |
| `validationPanel.result.notApplicable` | Die Spezifikation 1 enthielt keine anwendbaren Bauteile |
| `checkAuthoring.skippedModels` | Das geladene Modell 1 hat keine analysierten Daten und wurde nicht überprüft. |
| `checkAuthoring.dryRunOn` | Trockenlauf am Modell 1 (es wurde nichts gespeichert oder neu eingefärbt) |
| `semanticAssist.idsSkipsModels` | Der IDS-Entwurf überprüft das geladene Modell 1 nicht: IDS hat keine Version für sein IFC-Schema (z. B. IFC5). |
| `reviewWorkspace.actions.excludedHasTopic` | Die Karte 1 hat bereits ein BCF-Thema und wurde weggelassen. |
| `reviewWorkspace.actions.reportSaved` | Karte 1 zu einem neuen Dokument im Bedienfeld „Dokument“ hinzugefügt. |

**Caller evidence:** `components/viewer/validation/ValidationResultHead.tsx:47,56` counts all specifications with zero applicable elements and no error; it passes that count, never a specification index. If only the third specification has no applicable elements, the German warning still identifies “Spezifikation 1”. `components/viewer/check-authoring/DryRunResults.tsx:43-44` passes `checkedModels.length` and `skippedModels.length`. In a federation with several checked models and one skipped model, the skipped model need not be the first. `components/viewer/assistant/RequirementDispatch.tsx:162` likewise passes `loaded.unchecked`.

`components/viewer/review/ReviewActions.tsx:32-36` counts excluded cards, while lines 55-57 and 73-80 use the number of selected/shown cards. Select any single later card: the German action/confirmation identifies it as “Karte 1”. This can misdirect investigation of unchecked coverage and misstate which review item was exported or excluded.

**Composition also affected:** `components/viewer/ExportChangesReviewDialog.tsx:177` supplies `groups.length` to `exportChangesReviewDialog.modelsCount`, then embeds the result in a change summary. Resolving the actual pair for one change/one model produces “Die 1 Änderung in Modell 1 wird auf die exportierte Datei angewendet.” It must describe one model, not invent a model identifier. Lower-impact same-class occurrence: `checkAuthoring.proposalDocumentSummary` resolves to “Abschnitt 1” instead of a count of sections.

**Required correction:** preserve cardinal meaning (“1 Spezifikation …”, “1 geladenes Modell …”, “1 Karte …”; case-aware wording for embedded model counts). Repair the plural of `checkAuthoring.skippedModels` too: its actual two-model output is “Mit 2 geladene Modelle haben …”. Validate caller scenarios where the only skipped/excluded item is not the first, and one-versus-many export summaries. Existing plural sentinel checks cannot catch a count turned into an identifier.

## 2. P2 — Table mapping gives two editable controls the wrong domain meaning

**Location:** `apps/viewer/src/i18n/locales/de/table-corrections.ts:51,56`:

- `tableMapping.column` = **“Stütze”** (structural column).
- `tableMapping.set` = **“Menge”** (quantity).

**Caller evidence:** `components/viewer/actions/TableMappingCard.tsx:46-47` uses the first as the accessible name of a select whose options are the input table's `headers` and whose value is `column.column`. It chooses a spreadsheet column, not an IFC structural member. Lines 57-58 use the second as the accessible name of a text input bound to `column.pset` or `column.qset`, and write back that set name. It does not accept a quantity value. The English keys are “Column” and “Set”; the caller disambiguates both.

**Impact and scope:** in the proposed-table-mapping review, assistive-technology users are instructed to choose a structural member and edit a quantity while actually choosing a source column and a property/quantity-set name. These controls govern where imported edits go. This is a catalogue defect in existing catalogued accessible labels, not uncatalogued legacy copy.

**Required correction:** “Tabellenspalte”/“Spalte” and a set-name label such as “Name des Eigenschafts- oder Mengensatzes” (or target-specific translated labels). Verify the actual controls with property and quantity targets; preserve user-supplied column headers and IFC set names verbatim.

## 3. P2 — Elevation filter is labelled as storey height

**Location:** `apps/viewer/src/i18n/locales/de/search-filters.ts:74-75`: `elevationInputLabel` = “Geschosshöhe in Metern”; visible `elevationUnitHint` = “m (Geschosshöhe)”.

**Caller evidence:** `components/viewer/SearchModal.filter.editors.elevation.tsx:24-34` places these on the numeric comparison input and its visible unit hint. The actual evaluator in `packages/rules/src/filter/filter-evaluate.ts:533-535` calls `elevationOf`; `packages/rules/src/filter/filter-match.ts:301-307` resolves the element's storey and reads `hierarchy.storeyElevations`. It never calculates a floor-to-floor height. The English labels explicitly say “Storey elevation”.

**Impact:** “Geschosshöhe” denotes storey height and invites a height comparison. A storey at elevation 12 m with a 3 m storey height will match a `> 10` elevation filter; a height filter would not. The German control therefore describes a different physical quantity from the one evaluated.

**Required correction:** use “Höhenlage des Geschosses in Metern” / “m (Geschoss-Höhenlage)” or equivalent unambiguous elevation terminology. Verify negative, zero and positive elevations. This finding concerns the numeric filter, not every use of “auf Geschosshöhe” elsewhere.

## 4. P2 — Report-outline preview embeds untranslated enum values in German prose

**Locations:** `apps/viewer/src/i18n/locales/de/check-authoring.ts:81`; caller `apps/viewer/src/components/viewer/check-authoring/DocumentOutlineReview.tsx:33,42`.

`LiveTable` passes `rows: block.rows` directly into `checkAuthoring.liveRows`. `lib/document/types.ts:145` defines `ValidationRowsMode` as `'failed' | 'passed' | 'all' | 'sets'`; these are internal enum values, not user-authored labels. The German template is “aktuell: {count} {rows} Zeile[n] für {target}”. With no specification filter, `target` is the German catalogue value “jede Prüfung”.

**Actual resolver output using valid caller parameters:**

- `count: 1, rows: 'failed'`: “aktuell: 1 failed Zeile für jede Prüfung”.
- `count: 2, rows: 'passed'`: “aktuell: 2 passed Zeilen für jede Prüfung”.
- `count: 1, rows: 'all'`: “aktuell: 1 all Zeile für jede Prüfung”.
- `count: 2, rows: 'sets'`: “aktuell: 2 sets Zeilen für jede Prüfung”.

**Impact and attribution:** a user reviewing a proposed validation-report table sees its row-selection mode as an English implementation token. This is an existing caller localization gap exposed by the new German locale, not a German-induced change to row selection. It falls inside catalogued workflow composition; treating `{rows}` like arbitrary model text hides it from all-key/placeholder checks.

**Required correction:** localize the row mode in caller context, preferably with whole mode-specific messages so singular/plural German inflection is correct (or a neutral, separately labelled mode clause). Do not translate the enum stored in documents. Exercise all four modes with one and multiple rows through the composed preview.

## Startup, plural and coverage evidence

A fresh `node --import tsx --input-type=module` process imported `locales/de.ts`, `catalogue-problems.ts`, `en.ts` and `registry.ts` from this checkout. These were in-memory data/resolver probes, not a replacement for root Turbo tests.

- Before importing lazy English feature catalogues: 10,607 German keys, all 10,607 accepted by `checkCatalogue`, zero reported problems; the live English catalogue held 10,211 keys.
- Registered the checked German overlay and selected `de`. Recorded `resolve(key, { count: 1 })` for every German key. Imported every `catalogues/*.en.ts` export and registered its catalogue. Afterwards English had 10,607 keys, no English key lacked active German ownership, and none of the recorded German resolutions changed.
- Probed the reported singular-count messages with numeric counts 0, 1 and 2. The registry selects forms; the semantic errors are in the selected text. The zero-count output of warning keys is only a resolver probe: their callers gate warnings on positive counts.
- Probed the report-preview composition with all four valid row modes and counts 1 and 2. An earlier exploratory probe used `failures`, which is not a valid row mode; it is excluded from the findings. The valid-mode rerun above confirms the issue independently.
- `useTranslation.ts` returns this same `resolve` function as `t`. Outputs above are actual resolver results; caller reachability is source-traced. No component mount or screenshot is claimed.

To reproduce a representative message probe without building or writing files:

```sh
node --import tsx --input-type=module <<'JS'
import de from './apps/viewer/src/i18n/locales/de.ts';
import { registerLocale, setLocale, resolve } from './apps/viewer/src/i18n/registry.ts';
registerLocale('de', de);
setLocale('de');
console.log(resolve('validationPanel.result.notApplicable', { count: 1 }));
console.log(resolve('checkAuthoring.skippedModels', { count: 1 }));
console.log(resolve('reviewWorkspace.actions.excludedHasTopic', { count: 1 }));
for (const rows of ['failed', 'passed', 'all', 'sets']) {
  for (const count of [1, 2]) {
    console.log(resolve('checkAuthoring.liveRows', {
      count, rows, target: resolve('checkAuthoring.allChecks'),
    }));
  }
}
JS
```

## Acceptance limits

The existing REPORT/WORKFLOW browser results were read, not independently rerun. No claim is made about German layout across all panels, fresh browser negotiation, screenshots, real-model rendering, export downloads, full-suite tests, typecheck or lint in this review. The queued aggregate gate is still external to this review; no result for it was inferred from fleet status. The sampled source review is not an exhaustive semantic certification of all messages, and has no statistical score.

These findings do not contradict exact key coverage or the demonstrated sampled browser workflow. They do contradict treating those checks as sufficient evidence that all reviewed composition and coverage warnings retain their meaning. French implementation and both protected campaign trees were left untouched.
