# Viewer localization

English is the in-tree fallback. Feature catalogues live in `catalogues/` and
are composed in `en.ts`; keep them bounded to one user-facing feature instead
of growing a single catalogue file.

Translations must preserve every named parameter in their English template.
Callers pass formatted display values, while translators control word order,
punctuation, spacing, and unit placement. Use complete messages for states
rather than assembling translated fragments, lowercasing labels, or appending
suffixes. Missing keys fall back to English; an explicit empty string remains
empty.

The Section-tool catalogue contains 69 strings covering the mounted 3D
Section subtree: plane controls and state messages, cap styling, visualization
badges and the drag-gizmo tooltip, plus the two entry labels that open a 2D
drawing. It deliberately does not cover the drawing panel, toolbar, tours,
number formatting, or locale persistence. Locales registered in tests exercise
fallback and live catalogue replacement; they are not languages shipped by
the viewer.

## Adding a locale

Add one file, `locales/<tag>.ts`, named by its BCP 47 tag (`de.ts`,
`pt-BR.ts`), that default-exports a partial catalogue:

```ts
import type { Catalogue } from '../registry';

export default {
  'ribbon.tab.home': 'Start',
  'appearanceAssignmentList.summaryProducts': { one: '{count} Objekt', other: '{count} Objekte' },
} satisfies Catalogue;
```

No viewer code changes. `locales.boot.ts` discovers the file as a lazy chunk,
and the viewer picks a locale from `?lang=<tag>` (remembered in
`localStorage` under `ifc-lite:locale`; `?lang=en` switches back), then the
remembered choice, then the browser's languages (`de-CH` matches `de`), then
English. `<html lang>` follows the active locale.

`catalogue-problems.test.ts` loads every file in `locales/` and fails on keys
that no longer exist, dropped or renamed placeholders, and plural messages
without `other`; the same problems are logged in the browser console when the
locale loads. Untranslated keys fall back to English one by one, so a partial
locale is valid.

## Coverage

The ribbon toolbar catalogue covers the default toolbar's own chrome: tab
strip, group names, button labels, tooltips and aria-labels on all six tabs,
and the ribbon switch notice. Labels owned by shared registries (camera
commands, exporters, extension panels), the classic `MainToolbar`, and the
rest of the viewer's panels and dialogs are not converted yet.

The main-toolbar catalogue (#4918 slice 1) covers the classic single-strip
`MainToolbar`'s own chrome: file operations, the Panels/Edit-properties/View
options menus' own labels, tool buttons, the selection action cluster, and
the meta cluster (theme, info). It deliberately does not cover the shared
command surfaces the ribbon also renders — camera commands, the export menu,
workspace-panel toggle lists, and the class-visibility body — those are
slice 2 of the #4918 sweep.

The shared-commands catalogue (#4918 slice 2) covers the command lists both
`MainToolbar` and the ribbon render from: the export registry
(`export-commands.ts`, rendered by `ClassicExportMenuItems` /
`RibbonExportGroup`), the camera command registry (`camera-commands.ts`,
rendered by `CameraCommandMenuItems` / `ViewTab`), the bottom-panel and
author-panel toggle lists (`BottomPanelMenuItems`, `AuthorPanelMenuItems`),
and the class-visibility dropdown body (`ClassVisibilityMenuContent`). The
two data-only registries carry a translation key per row rather than calling
`t()` themselves (no React import), the same pattern `sectionConstants.ts`'s
`AXIS_INFO` uses; their renderers call `t(row.xKey)`. It deliberately does
not cover the command palette (`CommandPalette.tsx`, ~745 lines / 84
literals — sized for its own slice) or extension-contributed labels
(`extension.label`, sourced from the extension registry, not a literal) —
those remain for a later slice of the #4918 sweep.

The command-palette catalogue (#4918 slice 3) covers the Ctrl/Cmd+K palette's
static command labels, its browse-mode category headers, and its own chrome
(search placeholder, empty state, footer hints). The command TABLE itself
was split out of `CommandPalette.tsx` into `commandPaletteCommandsCore.ts` /
`commandPaletteCommandsPanels.ts` (data + `labelKey` rows, no `t()` call of
their own — same pattern as slice 2's registries) so the component stays
under its module-size budget. Recent-file names, script-template labels,
tour titles, and extension-contributed labels stay uncatalogued, same
reasoning as slice 2: each is runtime content, not a literal in this repo.

The Measure tool catalogue (#4918 slice 6, tools) covers `MeasurePanel.tsx`,
`MeasureQuantities.tsx`, `MeasurePointReadout.tsx`, `MeasurementVisuals.tsx`,
and the shared georeferenced readout `measure-modes/geo-readout.tsx`
(`measure.en.ts`). Measurement unit *symbols* (`m`, `m²`, `mm`, `°`) stay
literal in these files by this slice's own scope, distinct from the gate's
allowlist. The Space Sketch tool catalogue (`space-sketch.en.ts`) covers
`SpaceSketchOverlay.tsx` and its `space-sketch/` popovers, canvas, and
reopen pill. The wall-split tool catalogue (`split-tool.en.ts`) covers
`SplitNumericInput.tsx` and `SplitOverlay.tsx`. `SectionPanel.tsx`'s one
remaining literal was added to the existing `section-tool.en.ts` catalogue
rather than a new file.

The saved-list builder catalogue (#4918 slice 6, lists) covers
`ListBuilder.tsx`, `ListLibrary.tsx`, `ListGroupingBar.tsx`,
`ListModelTagScopeEditor.tsx`, `ListResultsTable.tsx`, `ListPanel.tsx`,
`ColumnHeaderMenu.tsx`, `ListScheduleTable.tsx`, and `ListErrorBox.tsx`
(`lists.en.ts`, per-sub-area key prefixes: `lists.builder.*`,
`lists.library.*`, `lists.panel.*`, `lists.resultsTable.*`,
`lists.scheduleTable.*`, `lists.groupingBar.*`, `lists.modelTagScope.*`,
`lists.columnMenu.*`, `lists.errorBox.*`).

The 2D-section workspace catalogue (#4918 viewer-panels slice) covers
`Section2DPanel.tsx`: header controls and overflow menus, drawing modes,
annotation tools and guidance, export/print prompts, generation/error states,
empty-state and resize accessibility text (`section-2d.en.ts`). Runtime drawing
phase text and IFC/DXF data remain supplied by their owning systems.

The hierarchy catalogue (#4918 slice 4) covers the spatial tree's own
chrome: `HierarchyNode`'s row controls (visibility, expand/collapse,
elevation and count badges) and its split-out `ModelHeaderRow`, the Models
section header and its by-tag filter chips (`ModelsSectionHeader`), the
per-row tag strip and its tag editor dialog (`ModelRowTags`,
`ModelTagEditor`, `ModelTagChip`, `ModelTagGroupRow`), the sort control
(`HierarchySortControl`, whose `SORT_OPTIONS` table carries `labelKey`s the
same way `camera-commands.ts` does), and the Building Storeys display
controls (`StoreyDisplayControls`). Row NAMES, TYPE NAMES and TAG NAMES are
model content, not literals, and stay out of the catalogue.

The properties catalogue (#4918 slice 4) covers the Properties panel's own
chrome: the entity header actions, the assembly/spatial-location badges,
the small info cards (property sets, quantity sets, materials,
classification, documents, relationships, schedule, structural, raw STEP,
bSDD, model metadata, unit display), the georeferencing panel and its
EPSG lookup / federation-alignment / precision-grid / location-map
surfaces, and the Gantt task edit card. IFC EXPRESS attribute names
(`GeodeticDatum`, `MapProjection`, `MapZone`, `MapUnit`, `Name`,
`Description`, …) rendered as `GeorefRow`/`MaterialRow` labels keep the
house rule's exact schema spelling and stay out of the catalogue, same as
property/pset/material/classification/schedule NAMES and VALUES, which are
model content.

The appearance-panel catalogue (#4918 slice 4, split across
`appearance-panel.en.ts`, `appearance-workflows.en.ts`, and
`appearance-pickers.en.ts` purely to stay under the module-size budget;
all share the same `appearance.*` key namespace) covers the rest of the
Appearance panel: the panel-level view (source-action switch, status line,
apply/discard footer), the source/scope/mapping/calibration/annotation field
groups, the PDF page/crop/fidelity-report/password surfaces, the drawing
reference library and multi-scope assignments (and their membership-review
flow), the mesh/point capture previews and face-mask picker, and the scan
capture/alignment/transfer workflows. It is a sibling to
`appearance-assignment-list.en.ts` / `appearance-assignment-members.en.ts`,
which cover `AppearanceAssignmentList`/`AppearanceAssignmentMembers`.

The Add Element authoring catalogue (#4918 editor-workflow slice) covers
`AddElementPanel.tsx`: element and dimension controls, complete placement
guidance messages, accessibility labels, and the Auto Spaces preview and
generation states (`add-element.en.ts`). IFC enum values remain exact EXPRESS
identifiers and are rendered from a typed data table rather than translated.

The property-editor catalogue (#4918 editor-workflow slice) covers
`PropertyEditor.tsx`: inline value and type editing, scope confirmation,
property/quantity/classification/material authoring dialogs, class
reassignment, its pending badge, and undo/redo chrome
(`property-editor.en.ts`). Runtime IFC entity, property, quantity, and enum
names remain exact schema data; common material category display labels are
translated without changing their stored values.

The hierarchy catalogue (#4918 slice 4) covers the spatial tree's own
chrome: `HierarchyNode`'s row controls (visibility, expand/collapse,
elevation and count badges) and its split-out `ModelHeaderRow`, the Models
section header and its by-tag filter chips (`ModelsSectionHeader`), the
per-row tag strip and its tag editor dialog (`ModelRowTags`,
`ModelTagEditor`, `ModelTagChip`, `ModelTagGroupRow`), the sort control
(`HierarchySortControl`, whose `SORT_OPTIONS` table carries `labelKey`s the
same way `camera-commands.ts` does), and the Building Storeys display
controls (`StoreyDisplayControls`). Row NAMES, TYPE NAMES and TAG NAMES are
model content, not literals, and stay out of the catalogue.

The properties catalogue (#4918 slice 4) covers the Properties panel's own
chrome: the entity header actions, the assembly/spatial-location badges,
the small info cards (property sets, quantity sets, materials,
classification, documents, relationships, schedule, structural, raw STEP,
bSDD, model metadata, unit display), the georeferencing panel and its
EPSG lookup / federation-alignment / precision-grid / location-map
surfaces, and the Gantt task edit card. IFC EXPRESS attribute names
(`GeodeticDatum`, `MapProjection`, `MapZone`, `MapUnit`, `Name`,
`Description`, …) rendered as `GeorefRow`/`MaterialRow` labels keep the
house rule's exact schema spelling and stay out of the catalogue, same as
property/pset/material/classification/schedule NAMES and VALUES, which are
model content.
The IDS-panel catalogue (#4918 viewer-panels slice) covers `IDSPanel.tsx` and
the extracted validation progress, result-summary, filtering, isolation,
focus, specification, requirement, and entity chrome (`ids-panel.en.ts`).
The existing `IDSAuditSummary`, correction, report-export, and BCF-export
dialogs remain separate follow-up surfaces. IDS document titles/descriptions,
specification names, entity names/types/GlobalIds, requirement descriptions,
and failure details remain model/document content supplied by the IDS engine.
The clash-detection catalogue (#4918 viewer-panels slice) covers
`ClashPanel.tsx`: the header and help disclosure, the detection controls
(mode/tol/gap, run buttons, live progress), the result-summary toolbar
(group-by/sort, review-status filters, on-select focus mode, bulk actions),
the on-demand intersection-solid status line, the user's own exclusion list,
every empty/no-match/no-comparison state, and the per-row exclusion and
review-comment controls (`ClashExclusionActions`, `ExcludeAnyButton`,
`ClashReviewControls`). The `Critical`/`Major`/`Minor`/`Info` severity labels,
the three review-status labels, and the three sort-option labels moved to
the same data-table-plus-`labelKey` pattern `sectionConstants.ts`'s
`AXIS_INFO` and slice 2's command registries use. Deliberately out of scope:
`describeClash()`'s plain-language finding description is reused verbatim as
a BCF topic's persisted description in `createBcfTopic` — it is exported
CONTENT, not pure view chrome, and translating only the on-screen call site
while the BCF-exported copy stayed English would read as two languages for
one sentence depending on where it landed. The same reasoning keeps the BCF
topic `title`/`description` strings and the `'Clash report'` project name
untranslated. IFC class tags (`clash.a.tag`/`clash.b.tag`) and exclusion-rule
labels are model content throughout.

The stable model-resolution errors `resolveValidationTarget.ts` can return
("Model … is not loaded", "The selected model has no parsed IFC data to
validate", "No IFC model loaded") are catalogued too: that pure function
returns a `TranslatableMessage` (`labelKey` + optional `params`, `@/i18n/types.ts`)
rather than a literal string — it never calls `t()` itself — and `useIDS.ts`
stores that value verbatim in `idsError`; `IDSPanel.tsx`'s error banner is the
one place that resolves it with `t()`, at render time, so it retranslates on
a live locale switch like every other catalogued string here (#5030).

The document-panel catalogue (#4918 doc slice, `document.en.ts`) started as
#4993's `document-menu.en.ts` (the document menu's rename/duplicate/delete/
export/import actions) plus #4940's `document.en.ts` (the chart/image width
picker and the spacer block, added to `BlockEditor.tsx` alongside those
features). This slice extends the same `document.*` namespace with every
remaining literal in the three files the earlier slices left uncovered:
`BlockEditor.tsx`'s own chrome (the block-kind badge, the text/image/chart/
topic field groups, and the move/remove controls), `DocumentPanel.tsx`'s own
chrome (the document/page-size/orientation selects, the "Add block" menu,
the export button and its pluralized result toast, the unsaved-document
warning, and the empty-blocks state), and `DocumentPreview.tsx`'s empty-state
and unresolved-topic messages. Block and document CONTENT — typed template
text, a chart's own title, a BCF topic's own title, image data, a document's
own name — stays out of the catalogue as model/user data, same reasoning as
every other panel in this sweep.

The schedule/Gantt-panel chrome catalogue (#4918 slice 6, schedule) covers
`GanttToolbar.tsx`, `GanttEmptyState.tsx`, `AnimationSettingsPopover.tsx`,
`GenerateScheduleDialog.tsx`, `HeightStrategyPanel.tsx`,
`GanttWorkPlanSummary.tsx`, `GenerateAdvancedPanel.tsx`,
`GanttDragTooltip.tsx`, `GanttPanel.tsx`, and `GanttTaskTree.tsx`
(`schedule.en.ts`), a sibling to the narrower `gantt-work-calendar.en.ts`
(#4830's single work-calendar toggle, prefix `gantt.workCalendar.*`) with
no key overlap.

Slice 5 (#4918) covers `extensions/**` (a companion slice covers `mcp/**`,
`sources/**`, `tours/**`, the components root, and `ui/`):

- `extensions-flavors.en.ts` and `extensions-panels.en.ts` cover the
  Extensions panel's own chrome across its dialogs, cards, and sub-panels
  (flavor list/merge/import, capability review, audit log, privacy, ideas,
  repair queue, promote-tool, widget host) — extension-CONTRIBUTED labels
  (a flavor's own name/description, an idea's text, a plan's own copy) stay
  as data, same reasoning as slice 2/3's extension-registry exclusions.
Slice 5 (#4918) covers `mcp/**`, `sources/**`, `tours/**`, the components
root, and `ui/` (a companion slice covers `extensions/**`):

- `mcp.en.ts` / `mcp-playground.en.ts` cover the `/mcp` landing page and
  playground's own chrome (hero copy, playground shell, chat UI). Chat
  transcript content and general tool-call output are runtime data, not
  covered. The dispatcher is a narrow exception: its viewer-owned WebGL
  refusal result carries live `textKey` / `hintKey` metadata so that specific
  host-generated status remains localized when the locale changes.
- `sources.en.ts` covers the Cloud Sources panel across all ten
  `sources/` components. Real file/folder/project names from a connected
  source stay as interpolation params, never literal text.
- `tours.en.ts` covers the tour UI's own chrome (Learn tab, per-panel
  launcher, prerequisite card, first-run invite, step card controls).
  `tour.title` / `description` / `step.title` / `step.body` /
  `step.action.label` come from `TOUR_REGISTRY` (`@/lib/tours/registry`,
  outside this slice) — authored tour content, not UI copy in these
  components, so they are deliberately NOT catalogued, same reasoning as
  the command-palette catalogue's tour entries.
- `viewer-shell.en.ts` covers the components root's `ChunkErrorBoundary`
  fallback and the shared `ui/dialog.tsx` primitive's sr-only close label.

The chat catalogue (#4918 chat slice, `chat.en.ts`) covers `ChatPanel.tsx`'s
own chrome (header controls, the BYOK-needed banner, clear-confirmation
dialog, empty-state hint, post-authoring install CTA, attachment/usage
tooltips, and input placeholders), `ChatMessage.tsx`'s attachment row count,
`ExecutableCodeBlock.tsx`'s action buttons and console/status text, and
`ModelSelector.tsx`'s tier headers. The sibling `chat-byok.en.ts` covers the
"use your own API key" surfaces split out purely because they are their own
sub-feature: `ByokCredentialForm.tsx` (key/workspace entry, validation
messages, save/remove), `ByokKeyModal.tsx` (dialog chrome, trust bullets,
walkthrough), `ByokStreamingPill.tsx`'s tooltip, and `ByokTrustDiagram.tsx`'s
SVG labels. Chat message CONTENT, example-prompt text mapped to no i18n key
by this slice's own scope, and provider/model NAMES sourced from
`PROVIDER_META`/`getByokModelsForSource` remain runtime data, not literals —
same reasoning as the mcp/sources catalogues' exclusions above.

The Charts panel catalogue (`charts.en.ts`) covers the `charts/` directory's
own chrome: `ChartCard.tsx`'s title-bar controls (drag/frame/edit/remove) and
its empty-bucket message, `ChartEditor.tsx`'s field labels, aria-labels, and
the row-count/no-rows Source states (plus the pre-existing `chartEditor.
sourceFilter*` field from #4946), `ChartsPanel.tsx`'s header controls and
both empty states, `DashboardMenu.tsx`'s dropdown items, `ElementFieldPicker
.tsx`'s family/set/field controls and "(unavailable)" fallbacks, and
`ReportExportDialog.tsx`'s page-setup dialog. Chart TITLES, dashboard NAMES,
and field/column/set NAMES are runtime data chosen by the user, not
literals, and stay out of the catalogue. `ChartCard.tsx`'s computed
aggregation subtitle (`subtitleFor`, `describeAggregation`, `EMPTY_HINTS`),
the `TYPE_LABELS`/`SOURCE_LABELS`/`FOCUS_LABEL`/`SCOPE_LABEL`/
`FAMILY_LABELS` select-option data tables, and `DashboardMenu.tsx`'s
`window.prompt`/toast copy and `ReportExportDialog.tsx`'s toast/error copy
and title-block field table are out of scope for this slice — none of them
are hardcoded JSX text or a policed attribute the ending gate below flags —
and remain for a later slice.

The BCF-panel catalogue (#4918 slice: BCF) covers `BCFPanel.tsx`'s own
header/dialogs and its nine `bcf/` components: the topic create/edit form
(`BCFCreateTopicForm.tsx`), the OpenCDE server sign-in dialog and its connect
form (`BCFServerDialog.tsx`, `BCFServerConnectForm.tsx`, `BCFServerControl.tsx`),
the topic list and detail views (`BCFTopicList.tsx`, `BCFTopicDetail.tsx`),
the 3D/2D viewpoint-capture buttons (`BCFViewpointCaptureButtons.tsx`), and
`bcfHelpers.tsx`'s status-badge default (`bcf.en.ts`, prefix `bcf.*`, with
chrome shared by more than one of those surfaces — Close/Cancel/Save, the
author email placeholder — under `bcf.shared.*`). Pluralized/interpolated
states (selected-object count, comment count, the "replace N topics"
warning) are single templated messages selected by count or condition in
the component, never assembled fragments. BCF topic titles, descriptions,
authors, GUIDs, comments, labels, and dates remain runtime content from the
loaded or imported BCF project. `bcfHelpers.tsx`'s `TOPIC_TYPES`/
`TOPIC_STATUSES`/`PRIORITIES` stay literal English: they are the actual
`topic.topicType`/`topicStatus`/`priority` field VALUES this app writes into
exported BCF files, not display-only labels, so translating them would
desync the on-screen text from the round-tripped data.

The Layers panel catalogue (#4918 layers slice, `layers-panel.en.ts`, keys
prefixed `layersPanel.<component>.*`) covers the layer-stack panel's own
chrome across `LayersPanel.tsx` (empty-state hero, per-stratum row, author
badges), `LayerDraftSection.tsx` (pending-edit publish flow, including its
toasts), `LayerMergeSection.tsx` (candidate/target pickers, preview status,
bulk and per-conflict resolution controls), `LayerReviewSection.tsx`
(registry-review comments), `LayerProvenanceDetail.tsx` (the manifest
detail view and its check list), `LayerCheckEvidence.tsx` (fetched IDS
report summary), and `LayerDiffView.tsx` (the per-layer stack diff). Layer
NAMES, tag NAMES, content-address digests, ref/file names, and IFC
GlobalIds/composition paths are model or registry runtime data and stay out
of the catalogue — only the chrome around them is translated. This is a
sibling to the unrelated `merge-layers-banner.en.ts` (the multilayer-wall
geometry-merge setting's reload banner), not the same feature under a new
name.

The Compare panel catalogue (#4918 compare slice, `compare-panel.en.ts`,
keys prefixed `comparePanel.<component>.*`) covers `ComparePanel.tsx`'s own
header/empty-state/BCF-compose-strip chrome and its `compare/` components:
the run controls and ignored-classes picker (`CompareRunControls`,
`CompareBlacklist`), the results list and its Matched/Suggestions sections
(`CompareResultsList`, `CompareMatchGroups`, `CompareSuggestions`), the
"what changed" detail (`ChangeDetailView`, whose delta lines were combined
into single complete messages per the house rule against fragmenting a
translated message rather than left split across a unit suffix and three
axis labels), the download strip (`CompareExportBar`, including its
"identity entries imported" status text), and the "raise a BCF topic from
this change" affordance (`BcfFromChange`). The `+N more not shown` overflow
notice is one shared key used by all three list sections. This is a sibling
to the unrelated `compare-key-property.en.ts` (the authored-key picker
feature), not the same catalogue renamed. Element/type NAMES, IFC class
tags, and `bcfTextFromChange`'s BCF topic title/description stay literal —
the latter is persisted verbatim into an exported BCF topic, the same
reasoning the BCF-panel and clash-panel catalogues already document for
text that doubles as exported content.

**The sweep's ending gate:** `scripts/check-i18n-literals.mjs` walks the
TypeScript AST of every `apps/viewer/src/components/**/*.tsx` file for
hardcoded JSX text, `{'…'}`-wrapped JSX-expression string literals, and
`aria-label`/`title`/`placeholder`/`alt` string-literal attributes —
skipping IFC EXPRESS names, an explicit technical-acronym allowlist, and
short symbol/unit clusters (`⌘Z`, `m²`) — and ratchets a per-file count in
`scripts/i18n-literals-baseline.json` (wired into `pnpm lint` and CI's
node-tests job): a file's count may never rise above its baseline row,
and a fall also fails until `node scripts/check-i18n-literals.mjs --update` re-records it (a ratchet in both directions).
