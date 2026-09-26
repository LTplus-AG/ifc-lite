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
slice 2 of the #4918 sweep. The #4918 grab-bag slice added one more key,
`mainToolbar.editModeShortcutHint` ('E'): the bare keyboard-shortcut letter
next to the Edit-mode toggle trips the gate the same way the Measure
catalogue's bare "m" unit symbol does (see below).

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

The Measure tool catalogue (#4918 slice 6, tools) covers `MeasurePanel.tsx` (now the HUD bar `MeasureToolbar.tsx`, `MeasureHudReadouts.tsx` and the `MeasurementsPanel.tsx` side panel, #5502),
`MeasureQuantities.tsx`, `MeasurePointReadout.tsx`, `MeasurementVisuals.tsx`,
and the shared georeferenced readout `measure-modes/geo-readout.tsx`
(`measure.en.ts`). Measurement unit *symbols* (`m`, `m²`, `mm`, `°`) stay
literal in these files by this slice's own scope, distinct from the gate's
allowlist — except the bare "m" JSX text node next to the live geo readout,
which trips the gate despite the symbol allowlist (a single ASCII letter with
no modifier glyph isn't a recognized cluster) and was keyed as
`measure.geo.unitMeters` by the #4918 grab-bag slice, filling in a key this
slice had reserved with a comment but left unadded. The Space Sketch tool catalogue (`space-sketch.en.ts`) covers
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

The Drawing panel catalogue (#4918 viewer-panels slice, reshaped by #5494)
covers `components/viewer/drawing/`: the header, toolbar row (markup tools,
display chips, settings drawers, zoom), Export menu, status-line hints and
facts, export/print prompts, generation/error and empty states
(`section-2d.en.ts`). Runtime drawing
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
model content, not literals, and stay out of the catalogue. The same
catalogue's `hierarchy.panel.*` keys (#4918 slice: panel outer chrome) cover
`HierarchyPanel.tsx`'s own shell around that tree: the loading/no-model
empty states, the search field, the grouping-mode tab strip and Groups
sub-filter chips, the section header per grouping mode, the storey/class-
filter/type-isolation footer chips and their clear controls, and the
resize-divider hint.

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
model content. The same catalogue's `properties.panel.*` keys (#4918 slice:
panel outer chrome) cover `PropertiesPanel.tsx`'s own chrome that is not one
of those extracted cards: the empty state, the entity header's merge-layers
badge and world-coordinates disclosure, the IFC Attributes / Structure /
Zones collapsible sections and their inline attribute editor, the
Properties/Quantities/bSDD/Raw STEP tabs and each tab's empty state, the
occurrence/type/material property section labels, and the unified-storey
multi-entity view.

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
model content, not literals, and stay out of the catalogue. The same
catalogue's `hierarchy.panel.*` keys (#4918 slice: panel outer chrome) cover
`HierarchyPanel.tsx`'s own shell around that tree: the loading/no-model
empty states, the search field, the grouping-mode tab strip and Groups
sub-filter chips, the section header per grouping mode, the storey/class-
filter/type-isolation footer chips and their clear controls, and the
resize-divider hint.

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
model content. The same catalogue's `properties.panel.*` keys (#4918 slice:
panel outer chrome) cover `PropertiesPanel.tsx`'s own chrome that is not one
of those extracted cards: the empty state, the entity header's merge-layers
badge and world-coordinates disclosure, the IFC Attributes / Structure /
Zones collapsible sections and their inline attribute editor, the
Properties/Quantities/bSDD/Raw STEP tabs and each tab's empty state, the
occurrence/type/material property section labels, and the unified-storey
multi-entity view.
The IDS-panel catalogue (#4918 viewer-panels slice) covers `IDSPanel.tsx` and
the extracted validation progress, result-summary, filtering, isolation,
focus, specification, requirement, and entity chrome (`ids-panel.en.ts`). A
follow-up slice extended the same `idsPanel.*` catalogue to its four sibling
surfaces: `IDSCorrectionDialog.tsx` (the scalar-property correction dialog —
title, description, the "nothing to correct" alert, the requirement/value
form, the failed-entities list, and the applied/failed result summary),
`IDSExportDialog.tsx` (the BCF export settings dialog — topic-grouping
options and their hint text, the four toggle switches, and progress/footer
controls), `IDSAuditSummary.tsx` (the auditing/clean-document states, the
counts-strip severity words moved to a `labelKey`/`pluralLabelKey` pair on
`SEVERITY_TOKENS` the same way `sectionConstants.ts`'s `AXIS_INFO` does, the
filter tabs, and the issue-row "path"/"facet" field labels), and
`IDSReportExportButton.tsx` (the format dropdown's own labels, moved to a
`FORMAT_LABEL_KEYS` map with the same pattern, its aria-label, and the
export-format tooltip). IDS document titles/descriptions, specification
names, entity names/types/GlobalIds, requirement descriptions, and failure
details remain model/document content supplied by the IDS engine.
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

The sidebar/shell-chrome catalogue (#4918 slice, `shell-chrome.en.ts`,
prefixed `shellChrome.<component>.*` with a small `shellChrome.shared.*` for
strings genuinely reused across two of these files) is a sibling to
`viewer-shell.en.ts` — kept in its own file under a distinct prefix purely to
avoid any key collision, not because the scope differs. It covers the
unified sidebar's activity rail and its customize popover
(`ActivityBar.tsx`, `CustomizeSidebar.tsx`), the docked-pane host and its
resize handle and split controls (`SidebarDock.tsx`, `SidebarPanelHost.tsx`),
the floating/edge-snapped panel window and the popped-out OS/PiP window
chrome (`FloatingPanel.tsx`, `PanelWindowHost.tsx`), `ViewerLayout.tsx`'s own
top-level chrome (the safe-mode banner and the mobile bottom-sheet host's
floating Hierarchy/Properties buttons), `StatusBar.tsx`, and
`MobileToolbar.tsx`. Panel NAMES/TITLES sourced from the panels registry
(`@/lib/panels/registry`, outside this slice) are runtime data passed as
`{title}` interpolation params, same reasoning as every other slice treating
a registry-owned label as data rather than UI copy owned by the component
that renders it. `FPS`/`WebGPU` and the `ifclite.dev` link text are routed
through `t()` so the ending gate does not see them as untranslated JSX
literals, same reasoning the WebGPU-troubleshooting catalogue documents for
technical strings a translator is expected to leave unchanged.

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
toast copy and `ReportExportDialog.tsx`'s toast/error copy
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

The clash-tools catalogue (#4918 slice: clashrest, `clash-tools.en.ts`,
prefix `clashTools.<file>.*`) covers the seven clash-feature files the
`ClashPanel.tsx` and `clash-groups.en.ts` slices left uncovered:
`ClashExportActions.tsx` (the export button cluster: BCF-topic and CSV
buttons and their toasts), `ClashModelTagNotice.tsx` (the stale-tags
banner), `ClashBcfExportDialog.tsx` (the "Export to BCF" grouping/severity/
snapshot dialog), `ClashRevisionCompareDialog.tsx` (baseline save and
compare-across-revisions, including its exported `warningLines()` — moved
from returning plain strings to `TranslatableMessage`s, the same
`labelKey`-plus-`params` shape `resolveValidationTarget.ts` established, so
a locale switch retranslates its banner lines too), `ClashRuleDraftEditor.tsx`
and `ClashSetFilterEditor.tsx` (the add/edit-rule form and its per-side
advanced filter), and `ClashSettingsDialog.tsx` (the Detection/Rules
settings dialog, including its own `SettingRow` label/hint pairs, which sit
outside the ending gate's own attribute list but are real chrome text).
Severity labels (`Critical`/`Major`/`Minor`/`Info`) in `ClashBcfExportDialog.tsx`'s
`SEVERITIES` table and `ClashSettingsDialog.tsx`'s `SEVERITY` table reuse
the existing `clashPanel.severity.*` keys via a `labelKey` field rather than
duplicating them, the same data-table-plus-`labelKey` pattern `clash-panel.en.ts`'s
own `SEVERITY`/`REVIEW_STATUS` tables use. IFC class-selector examples
(`IfcWall`, `*`) stay literal per the house rule; a composite selector
pattern like `IfcPipe*` or `IfcWall|IfcSlab` is still catalogued so the
gate treats it consistently, with translators expected to leave the value
unchanged.

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

The Annotate tool catalogue (#4918 slice: annotations, `annotations.en.ts`)
covers the canvas-overlay pin (the shared `Pin` scene primitive, registered on
the projector by `AnnotationLayer.tsx` — #5511), the read/edit
popover for an existing pin (`AnnotationPopover.tsx`), and the inline
commit-or-cancel input shown while dropping a fresh pin
(`AnnotationDropInput.tsx`), including the relative-time phrasing
(`just now` / `{count}m ago` / `{count}h ago` / `{count}d ago`) both the
popover and (via a shared word) its own hints use. An annotation's own note
TEXT and its resolved entity TYPE NAME are model/runtime content and stay
out of the catalogue; only the surrounding labels, hints, and time phrasing
are translated here.

The anonymized-export catalogue (#4918 slice: anonymized export,
`anonymized-export.en.ts`) covers `AnonymizedExportDialog.tsx`'s own chrome
(title, description, seed-exclusion warnings, result count, export/error
status, and footer controls) and its four sub-panels: the anonymization
toggle rows (`AnonymizationOptionsPanel.tsx`, whose `ROWS` table carries a
`labelKey`/`effectKey` per row the same way `sectionConstants.ts`'s
`AXIS_INFO` does), the relationship-expansion toggles
(`RelationTogglePanel.tsx`), the checkable seed/related-entity list
(`RelatedEntityList.tsx`), and the per-IFC-class chip bar
(`TypeCategoryBar.tsx`). IFC class NAMES (`c.typeName`), entity NAMES/ids,
and the relationship/role identifiers used to build a group's label are
model content and stay out of the catalogue; only the surrounding labels,
hints, and status messages are translated here. `AnonymizedExportDialog.tsx`
distinguishing "entities" and warnings uses fixed-plural English wording for
the secondary count in a message (the `{warnings}` clause in
`exportedEntitiesWithWarnings`), the same simplification the layers
catalogue's `checkEvidence.summary` already accepts for a message with two
independent counts.

The Lens panel catalogue (#4918 viewer-panels slice, `lens-panel.en.ts`,
prefix `lensPanel.*`) covers `LensPanel.tsx`'s own chrome: the header
(export/import/clear/close) and footer status line, the rule list
(`RuleRow`'s isolate tooltip and isolated badge) and its editor
(`RuleEditor`'s criteria-type/operator/action selects, per-type
placeholders, duplicate/remove/reorder controls, and the compound-criteria
read-only state), the auto-color editor (`AutoColorEditor`'s source/pset/
property fields and the "Show unclassified" toggle), and the read-only
lens card (`LensCard`'s edit/delete/duplicate tooltips, rule count, and
auto-color legend with its sort control). The rule-criteria-type and
auto-color-source display table and the operator table moved to the same
data-table-plus-`labelKey` pattern the clash-panel catalogue's `SEVERITY`/
`REVIEW_STATUS` tables use, relocated into a new sibling module
(`lens-editor-labels.ts`) to keep `LensPanel.tsx` under its module-size
budget rather than growing it further. The `'New Rule'` default rule name
and the `'Color by '` auto-color name prefix stay English: both are
equality-checked sentinels the component uses to detect an unrenamed
default before substituting a localized type label, and translating the
sentinel itself would desync it from the literal compared against on a
non-English locale — the same reasoning that keeps `bcfHelpers.tsx`'s
`TOPIC_TYPES` field values untranslated. IFC class names and property/
quantity/classification/material/model/zone NAMES and VALUES discovered
from the loaded model remain runtime data throughout.

The Search Modal / Search Inline catalogue (#4918 search-modal slice) covers
the SearchModal family and the always-visible toolbar field: the dialog
shell (`SearchModal.tsx`), the Search tab's chip filters, result list and
footer batch actions (`SearchModal.text.tsx`), the Filter tab's run bar,
progress/limit badges, error box and result table (`SearchModal.filter.tsx`),
the chip-editing builder and preset menu (`SearchModal.filter.builder.tsx`),
every per-kind rule chip editor (`SearchModal.filter.editors.tsx` and its
split-out `.elevation.tsx` / `.identity.tsx` siblings), the selector text
field (`SearchModal.filter.selector.tsx`), and `SearchInline.tsx`'s field,
vim-cycle hint, recents popover and results popover (`search-modal.en.ts`
covers the shell/text/filter-run/inline sub-areas; `search-filters.en.ts`
covers the filter-builder/filter-editors/filter-selector sub-areas — split
purely to stay under the module-size budget, both share the `searchModal.*`
prefix). GlobalIds, IFC type names, and entity/property/model NAMES stay
literal throughout — model content, not view chrome. A created list's
default `name: 'Filter result'` and its seeded column `label`s ('Name',
'Class') also stay literal: the moment `handleCreateList` runs they become
persisted, user-renamable list data, same reasoning as a BCF topic title or
document name elsewhere in this sweep.

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

The model-reposition catalogue (#4918 slice, `reposition-panel.en.ts`,
prefix `repositionPanel.*`) covers the `reposition/` directory:
`RepositionPanel.tsx` (the floating panel's header, moving/reference model
pickers, framing shortcuts, point-picking prompts, constraint/input-mode
controls, the move-dimensions readout, and the apply/undo/redo/reset
actions), `RotationControls.tsx` (the heading and pivot fields, their
guidance text, and the per-model rotation summary), `PlacementGizmo.tsx`
(the drag-handle SVG's aria-labels and its live delta readout),
`PlacementFiles.tsx` (the save/restore-placements disclosure and its
instance-mapping fieldset), and `StaleMeasurementBadge.tsx` (the single
stale-measurement indicator). Model NAMES stay as interpolation params;
the hover-target kind (vertex/edge/face/point/origin/bounds) and the
source/target pick role are internal enums whose display words moved to
the same data-table `labelKey` pattern `sectionConstants.ts`'s
`AXIS_INFO` and slice 2's command registries use.

The export-dialog catalogue (#4918 slice: export/panel outer chrome,
`export-dialog.en.ts`) covers `ExportDialog.tsx`'s own chrome: the trigger
button, the dialog title/description, the scope/mixed-units/model/schema
selectors, the schema-conversion warning, the output indicator, every
option switch and its hint text (visible-only, include-geometry,
apply-property-changes, changes-only, IFC5-only-known-properties), the
pending-changes banner, the export-progress readout, the success/error
result banner, and the footer cancel/export controls. Schema version codes
(`IFC2X3`, `IFC4`, …) and file extensions remain exact identifiers and
stay out of the catalogue. This is a sibling to `PropertiesPanel.tsx`'s and
`HierarchyPanel.tsx`'s own `*.panel.*` outer-chrome keys documented above —
all three files' INNER content (the extracted property/quantity cards, the
tree row/node chrome) was already covered by an earlier slice; this slice
covers the panel/dialog SHELL around them.

The WebGPU-troubleshooting catalogue (#4918 slice: webgpu/script,
`webgpu-troubleshooting.en.ts`) covers `WebGpuTroubleshooting.tsx` in full:
the empty-state disabled-file caption, the category-branched banner
headline, the collapsible troubleshooting steps for each
`WebGPUUnavailableReason` category (insecure origin, browser not exposing
WebGPU, and the blocklist/Firefox/Safari/verify-status block), and the
always-shown CLI/MCP fallback notice. The banner headline is resolved by a
plain function, not a component, so it takes a `t: typeof resolve = resolve`
default parameter straight from the locale registry (`@/i18n/registry`)
instead of the `useTranslation()` hook — the same non-hook translator shape
`bulk-property-value.ts` already uses. Browser flag names, config paths, and
CLI incantations are catalogued like every other literal in this file even
though a translator is expected to leave them unchanged, the same reasoning
the clash-tools catalogue documents for a composite IFC class-selector
pattern.

The Script-tool chrome catalogue (#4918 slice: webgpu/script,
`script-panel.en.ts`) covers `ScriptPanel.tsx`'s own chrome: the header
(default title, saved-script selector, AI-chat toggle, close), the
post-authoring "install as tool" banner, the run/save/save-as-tool/undo/
redo/new-script/reset-sandbox toolbar and its tooltips, the execution
status indicators, the output console (the QuickJS sandbox hint, "Fix with
LLM", the return-value label, and the empty state), and the delete
confirmation dialog. `useScriptState` (the consolidated Zustand selector)
and `formatLogArgs` (a pure log-argument formatter) moved to a sibling
`scriptPanelState.ts` purely to keep `ScriptPanel.tsx` under its
module-size budget after localizing its JSX — neither needs `useTranslation()`,
since neither renders anything. `'Untitled Script'`, the default name a
newly created script gets, stays literal: the moment it is saved it becomes
persisted, user-renamable data, the same reasoning the search-modal
catalogue documents for a created list's default `name: 'Filter result'`.

The zones/rooms catalogue (#4918 zones slice, `zones-panel.en.ts`, prefix
`zonesPanel.*`) covers five files: `ZonesPanel.tsx` (author + manage location
zones, issue #1810), its straddler-volume companions
`ZoneApportionSummary.tsx` and `ZoneVolumeBreakdown.tsx` (issue #2508), the
export/write-back surface `ZoneWriteBackControl.tsx`, and — grouped into this
slice for its file-count rather than its topic — `RoomPanel.tsx`, the
collaboration room roster ("room" there means a live collab session, not an
IFC spatial room). Zone NAMES the user assigns, generated-set default names
(`'Untitled set'`, `'Storeys'`) that become renamable data the instant they
are created, and export file names remain runtime content and stay out of
the catalogue. `RoomPanel.tsx`'s `STATUS_META`/`SEEDING_META` (connection dot)
and `ROLE_META` (collab role badge) moved to the same data-table-plus-
`labelKey` pattern `sectionConstants.ts`'s `AXIS_INFO` and the clash-panel
severity/review-status tables use; `ZonesPanel.tsx`'s `ZoneRow` Center/Size
field-label tuples moved to arrays of translation keys for the same reason.
Multi-clause status lines built from independent optional counts (the
apportionment coverage footer, the geometry-export success toast) render
each clause as its own translated span/branch joined by a plain, letter-free
' · ' separator rather than concatenating translated fragments in code, the
same reasoning `ClashRevisionCompareDialog.tsx`'s `warningLines()` and the
layers catalogue's `checkEvidence.summary` already document.

The Data Connector catalogue (#4918 slice, `data-connector.en.ts`, prefix
`dataConnector.*`) covers `DataConnector.tsx`'s own chrome: the trigger
button, the dialog header and step indicator, the target-model and
CSV-file pickers, the data-preview table caption, the entity-matching
controls (match-by/CSV-column/property-set/property-name fields), the
property-mapping list (its header actions, empty state, column headers,
and per-row field placeholders and value-type options), the
match-results/import-progress/import-complete/error alerts, and the
footer's preview/import buttons. CSV column NAMES, sample cell VALUES,
and model NAMES are runtime content and stay as interpolation params.
`GlobalId` and `EXPRESS ID` describe IFC's own match-by mechanisms and
keep their exact technical spelling, same house rule as every other IFC
EXPRESS name in this sweep — only routed through `t()` so the ending gate
does not see them as untranslated JSX literals. Thrown `Error` messages
surfaced only through `err.message`, never rendered as their own JSX
literal, stay English, same as the rest of this sweep's panels.

The geometry-export dialogs catalogue (#4918 slice: geometry export,
`geometry-export-dialogs.en.ts`, sub-namespaced `geometryExport.glb.*` /
`geometryExport.kmz.*` / `geometryExport.usd.*` / `geometryExport.energy.*` /
`geometryExport.editCard.*` in one file to keep the five owning components'
own PR small) covers `GLBExportDialog.tsx`, `KmzExportDialog.tsx`,
`UsdExportDialog.tsx`, `EnergyModelExportDialog.tsx`, and the Properties
panel's inline `GeometryEditCard.tsx` — grouped into the same file as the
four export dialogs purely because it is a small slice sibling, not because
it shares any export machinery with them. A `geometryExport.shared.*`
prefix holds the handful of strings identical across dialogs (the
`'Current Model'` fallback display name, the `'Unknown error'` fallback
reason, and the `'Geometry engine unavailable'` wasm-boundary error) rather
than duplicating each per sub-namespace. File format names (GLB, glTF, KMZ,
COLLADA, USD, USDA, OpenUSD, HBJSON, DFJSON, Honeybee, Dragonfly, Ladybug
Tools), IFC EXPRESS names (`IfcSurfaceStyleRendering`, `DiffuseColour`,
`SurfaceColour`, `IfcMapConversion`, `IfcSpace`, `OrthogonalHeight`), USD
scene-description attribute literals (`upAxis`, `metersPerUnit`, `Xform`,
`UsdGeomMesh`, `UsdPreviewSurface`, `purpose = "guide"`), and axis/unit
symbols (X, Y, Z, m, °) stay literal per the house rule, passed as
interpolation params rather than translated. A thrown `Error`'s own
`.message` (surfaced from the wasm geometry engine or an unexpected
exception) is likewise interpolated as a parameter, never translated
itself — it is engine content, not UI chrome.

The grab-bag catalogue (#4918 final wave, `misc-panels-b.en.ts`, one key
prefix per component) covers the last group of small standalone files the
sweep's earlier slices left uncovered: `PointCloudPanel.tsx`,
`PointCloudClasses.tsx`, and `PointCloudLegend.tsx` (the point-cloud
rendering controls, per-ASPRS-class visibility list, and intensity/height
ramp legends — the `COLOR_MODES`/`SIZE_MODES` tables moved to the same
`labelKey`/`hintKey`-per-row pattern `sectionConstants.ts`'s `AXIS_INFO`
uses); `ModelTagRuleEditor.tsx` (the shared `modelTag` chip rule editor,
whose fragmented unresolved-tag warning became one templated plural
message); `FederationSetupControls.tsx` (the save/reopen federation-setup
dialog, including its `confidenceBadge()` match-confidence table);
`ShareDialog.tsx` and `ShareScopeField.tsx` (the accountless link-sharing
dialog and its multi-model scope picker, including the `ROLE_OPTIONS` table
and every derived caption/notice the dialog renders); `LoadReportPanel.tsx`
(the per-model geometry load-warning report, including its `statusLabel()`
table and per-entity summary line); `GeometryModeBanner.tsx` (the
reload-to-apply Fast/Exact geometry banner); `FilterRuleControls.tsx` (the
shared AND/OR combinator toggle and "Add rule" menu); `GeometryAxisRow.tsx`
(the Geometry edit card's X/Y/Z nudge row); `VisibilityChips.tsx` (the
viewport visibility reasons); `TextAnnotationEditor.tsx` (the 2D-drawing
text annotation inline editor); `presence/PeerPresenceLayer.tsx` (the live
collaborator-cursor DOM overlay); `BottomStrip.tsx`'s detach grip;
`SaveMarkupToModelButton.tsx` and `ExportChangesButton.tsx` (the two
dedicated export-adjacent toolbar buttons); and `SearchableSelect.tsx` (the
searchable dropdown `LensPanel`'s editors use). `EntityContextMenu.tsx`
contributes only its default-direction duplicate row's own literal text —
the rest of that menu's per-action `label` props are plain JSX attributes
the gate below does not police and remain out of this slice's scope, same
reasoning the main-toolbar and shared-commands catalogues already document
for labels owned by shared command surfaces. Toast/console messages that
never reach the DOM (`FederationSetupControls.tsx`'s and
`ExportChangesButton.tsx`'s `toast.*` calls, `SaveMarkupToModelButton.tsx`'s
`refusalText()`) are deliberately left English, same reasoning several
earlier slices already document for copy that is not on-screen chrome.
Point-cloud ASPRS CLASS names (`lasClassificationName()`) are model content
loaded from the scan and stay out of the catalogue, same house rule as an
IFC class/property/tag NAME anywhere else in this sweep.

The Info dialog catalogue (#4918 slice: keyboard shortcuts,
`keyboard-shortcuts.en.ts`) covers `KeyboardShortcutsDialog.tsx` in full —
exported under that legacy name though it renders all four Info tabs, not
only Shortcuts: the header (title, MCP cross-link CTA) and footer
("Press ? to toggle this panel"), the tab strip, the About tab (the
privacy disclosure's intro/WASM link/verification line, the app name,
version, homepage/docs/GitHub/report-issue links, license, and the
package-count disclosure), the What's New tab (the current-version banner,
per-release version/viewer-badge/change-count, and the Feature/Fix/Perf
legend), and the Shortcuts tab's own "Learn more" row. Shortcut CATEGORY
names, DESCRIPTIONS, and key-combination glyphs (`⌘`, `Ctrl`, `⇧`) come
from `KEYBOARD_SHORTCUTS` (`@/hooks/keyboard-shortcuts-list`) and stay out
of the catalogue as model content, same reasoning as every other data
table in this sweep; the `F12` key name in the privacy disclosure is
likewise routed through `t()` without translation, the same house rule
that keeps `GlobalId` and IFC EXPRESS names spelled exactly while still
satisfying the ending gate. `LearnTab.tsx` (the fourth tab) has its own
catalogue outside this slice.

The drawing-underlay catalogue (#4918 slice: keyboard shortcuts + drawing
underlay, `drawing-underlay.en.ts`, prefix `drawingUnderlay.*`) covers two
siblings under one namespace because they are the same 2D-drawing-overlay
feature: `settings.*` is `DrawingSettingsPanel.tsx`'s graphic-override
presets and custom-rule editor, and `dxf.*` is `DxfUnderlayPanel.tsx`'s
imported-DXF reference-underlay manager (issue #1782/#1929/#2043),
including its per-layer hide/show titles, the warnings/skipped-entities
disclosures, the opacity control, and the tri-state "Align to model
georeference" toggle and its auto/on/off hint text. IFC class NAMES
(`COMMON_IFC_TYPES`), the line-weight preset table, and DXF layer/file
NAMES from the imported drawing remain model or registry runtime data and
stay out of the catalogue; the `mm` unit suffix is routed through `t()`
without translation, same reasoning as the `F12` key name above.

The Cesium / geo-basemap catalogue (#4918 slice: cesiumgeo, `cesium-geo.en.ts`)
covers the geospatial-basemap feature area's five files:
`CesiumPlacementEditor.tsx` (the drag-to-move georeference gizmo and its
floating panel — header, delta readouts, the map-absolute guard warning,
the nudge/height/rotate control clusters, and the apply/reset actions),
`CustomBasemapEditor.tsx` and `CustomTilesetEditor.tsx` (the custom XYZ-tile
and 3D-Tiles input surfaces under the Sun & Sky panel's Base map selector,
including their third-party-privacy disclosures), `CesiumOverlay.tsx` (the
globe's own loading/error/basemap-warning banners), and `AxisHelper.tsx`
(the 3D axis-triad labels). `Eastings`, `Northings`, and `OrthogonalHeight`
are exact `IfcMapConversion` EXPRESS attribute names used as bare field
labels — the same house rule `GeoreferencingPanel.tsx`'s `GeorefRow` labels
already follow — and stay literal wherever a label uses them bare; a full
sentence that happens to mention one (the drag-gizmo's tooltip titles, the
panel's own usage hint) is still one catalogued message. `Delta E/N/Z/R`
and `XAxis angle` are UI-chosen abbreviations rather than schema spelling,
so they are catalogued. The nudge-button glyphs (`N+`, `E-`, `Z+`, `R-`, …)
and the axis-triad's `X`/`Y`/`Z` letters are catalogued too even though a
translator is expected to leave them unchanged, the same reasoning the
WebGPU-troubleshooting catalogue documents for browser flag names. The
`Remove` button shared verbatim by the basemap and tileset editors uses one
`cesiumGeo.shared.removeButton` key rather than two copies, the same
pattern the BCF-panel catalogue's `bcf.shared.*` prefix uses. A saved
basemap/tileset URL is runtime data; the example URLs shown as field
placeholders are this slice's own copy and are catalogued like any other
placeholder.

The viewport/lighting catalogue (#4918 slice: viewport/lighting,
`viewport-lighting.en.ts`) covers the 3D-viewport chrome and the Sun & Sky
lighting controls across seven files: `ViewportContainer.tsx` (the no-model
welcome/empty state, its WebGPU-unavailable banner, and the loaded-model
"Add Model" drop overlay), `ViewportOverlays.tsx` (the mobile touch-nav
cluster, the selected-storey count, and the per-model basepoint toggle),
`Viewport.tsx`'s own renderer-init failure fallback, `FlySpeedIndicator.tsx`'s
fly-mode HUD, and the Environment panel's own chrome plus its two sub-panels
(`EnvironmentPanel.tsx`, `ShadowControls.tsx`, `SunTimeControls.tsx`).
`EnvironmentPanel.tsx`'s `CONTEXT_SOURCES`/`SWEEP_MODES` select-option tables
moved their `label`/`hint` fields to `labelKey`/`hintKey`, the same
data-table-plus-`labelKey` pattern `sectionConstants.ts`'s `AXIS_INFO` and
this sweep's other select tables use — component `label` props are not
policed by the ending gate below, but leaving those two dropdowns hardcoded
while the rest of the panel translated would read as two languages in one
panel. `ShadowControls.tsx`'s `resolutionLabel` takes the same non-hook
`t: typeof resolve = resolve` default parameter `bulk-property-value.ts`
already uses, since it is a plain formatting function, not a component. The
pluralized "Drop to federate with N existing model(s)" and "N storeys"
states are single templated messages selected by count, never assembled
fragments, the same reasoning this sweep's other counted states already
document. `ViewportContainer.tsx`'s inline `<style>{`@keyframes…`}`</style>`
CSS moved to a module-level `FLOAT_SLOW_KEYFRAMES` constant — plain CSS, not
translatable prose, but the AST gate cannot tell a keyframe declaration from
JSX text sitting in a `{'…'}` child position, so it stayed a false positive
until moved out of that position entirely. A selected storey's own NAME, and
a loaded model's own displayed name, remain runtime content and stay out of
the catalogue.

The grab-bag catalogue (#4918 slice: standalone panels, part 1,
`misc-panels-a.en.ts`) bundles five otherwise-unrelated one-off dialogs/panels
under their own key prefixes purely for PR-count efficiency:
`BasketPresentationDock.tsx` (`basketPresentationDock.*`, the pinboard
"Presentation" dock's header, source/visibility/save/play-all controls, the
saved-view strip, and the resize handle), `DeviationPanel.tsx`
(`deviationPanel.*`, the BIM/scan deviation heatmap's compute button, stats
line, range slider, and legend, plus its `setError` messages), the pre-export
`ExportChangesReviewDialog.tsx` (`exportChangesReviewDialog.*`, the summary
line and the per-change-kind/value-fallback labels `describeChangeKind` and
`describeEntity` now resolve rather than returning bare English strings — the
former threads the component's own `t` since it runs at render time inside
`groups.map`, the latter takes an optional non-hook translator like
`webGpuBannerBlurb` since it runs once inside `buildReviewGroups`, outside any
component), `ScanSectionPanel.tsx` (`scanSectionPanel.*`, the point-cloud scan
overlay's toggle, thickness/opacity sliders, and status footnote), and
`SpaceMousePanel.tsx` (`spaceMousePanel.*`, the 3Dconnexion device panel's
connect/disconnect, sensitivity, and diagnostics readout). Several
counted-fragment JSX expressions were combined into single templated messages
per the house rule against fragmenting a translated message — the basket
dock's `{count} in basket`, the deviation stats line, the SpaceMouse
diagnostics report line — rather than left split across raw JSX text and a
bare unit suffix; `spaceMousePanel.layoutLine` and
`exportChangesReviewDialog.changesSummary` instead nest a second `t()` call
for a sub-label (the layout source, the model count) inside their own
template, the same shape `RoomPanel.tsx`'s `statusRoom` already uses.
`spaceMousePanel.headerLabel` / `deviceNameFallback` / `connectButton` keep
the literal English word `SpaceMouse` as their catalogue value — a device
name, not translated prose, per the house rule — routed through `t()` only so
the ending gate does not see it as an unconverted JSX literal, the same
reasoning the geometry-export and webgpu-troubleshooting catalogues document
for a technical string a translator is expected to leave unchanged.

The sheet/title-block and PDF-view catalogue (#4918 sheets/PDF slice,
`sheets-pdf.en.ts`) covers five files behind one `sheetsPdf.*` namespace,
split by owning surface: `TitleBlockEditor.tsx` (`sheetsPdf.titleBlock.*`,
the field-editor dialog's standard/custom-field forms, logo upload, and
revision history), `SheetSetupPanel.tsx` (`sheetsPdf.sheetSetup.*`, the
paper/frame/scale/title-block/scale-bar sections and the saved-templates
list — its `FRAME_STYLE_OPTIONS`/`TITLE_BLOCK_LAYOUT_OPTIONS` tables moved
to the same data-table-plus-`labelKey` pattern `sectionConstants.ts`'s
`AXIS_INFO` uses), and the to-scale 3D-view PDF export dialog's three files
(`sheetsPdf.pdfView.*`): `PdfViewExportDialog.tsx`, its appearance controls
`PdfViewAppearanceSection.tsx`, and its page-size/oversize/projection
notices `PdfViewPageNotices.tsx`. `describeShadingResolution` (a plain
function, not a component) takes the same `t: typeof resolve = resolve`
default-parameter shape `bulk-property-value.ts` and
`WebGpuTroubleshooting.tsx` use. Several readouts in `SheetSetupPanel.tsx`
and `PdfViewPageNotices.tsx` were fixed-fragment concatenations (e.g.
`'Estimated page: ' + width + ' x ' + height + ...`); each became one
complete message per branch (fits an ISO sheet / does not / not available
yet) rather than assembled from translated pieces, the same reasoning the
layers and clash-tools catalogues already document for a multi-clause
status line. Title-block field VALUES the user types, field LABELS (preset
data from `@ifc-lite/drawing-2d` or a user-chosen custom label), revision
author/date/description content, saved-template NAMES, and paper size
NAMES/millimetre/dpi figures remain model or unit/symbol content per the
house rule and stay out of the catalogue — only interpolated as params.

**The sweep's ending gate:** `scripts/check-i18n-literals.mjs` walks the
TypeScript AST of every `apps/viewer/src/components/**/*.tsx` file for
hardcoded JSX text, `{'…'}`-wrapped JSX-expression string literals, and
`aria-label`/`title`/`placeholder`/`alt` string-literal attributes —
skipping IFC EXPRESS names, an explicit technical-acronym allowlist, and
short symbol/unit clusters (`⌘Z`, `m²`) — and ratchets a per-file count in
`scripts/i18n-literals-baseline.json` (wired into `pnpm lint` and CI's
node-tests job): a file's count may never rise above its baseline row,
and a fall also fails until `node scripts/check-i18n-literals.mjs --update` re-records it (a ratchet in both directions).
