/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Document panel's own chrome (#4918 doc slice), covering
 * `BlockEditor.tsx`, `DocumentPanel.tsx`, and `DocumentPreview.tsx`. The
 * `document.block.width*` / `heightPtLabel` / `chartHeightAriaLabel` /
 * `spacerHeightAriaLabel` / `textStyle*` / `addBlock.spacer` keys predate
 * this slice (#4940's chart/image width picker and spacer block); this
 * slice extends the same `document.*` namespace with every remaining
 * literal in the three files rather than starting a new catalogue. See
 * the i18n README's document coverage paragraph for what stays out of
 * scope (block/document CONTENT: typed text, chart titles, topic titles,
 * image data, document names).
 */
import type { TranslationValue } from '../types';

export const documentEn = {
  'document.block.widthLabel': 'Width',
  'document.block.widthAriaLabel': 'Block width',
  'document.block.widthTitle': 'Half pairs with the next half chart/image into one row',
  'document.block.widthFull': 'Full',
  'document.block.widthHalf': 'Half',
  'document.block.heightPtLabel': 'Height (pt)',
  'document.block.chartHeightAriaLabel': 'Chart height',
  'document.block.spacerHeightAriaLabel': 'Spacer height',
  'document.block.textStyleSubheading': 'Subheading',
  'document.block.textStyleSmall': 'Small',
  'document.block.textStyleCaption': 'Caption',

  // BlockEditor.tsx (#4918 doc slice): the block-kind badge, and every
  // field/control each block kind renders.
  'document.block.kindText': 'Text',
  'document.block.kindImage': 'Image',
  'document.block.kindChart': 'Chart',
  'document.block.kindTopic': 'BCF topic',
  'document.block.kindSpacer': 'Spacer',
  'document.block.kindTable': 'Table',
  'document.block.styleLabel': 'Style',
  'document.block.textStyleAriaLabel': 'Text style',
  'document.block.textStyleTitle': 'Title',
  'document.block.textStyleHeading': 'Heading',
  'document.block.textStyleBody': 'Body',
  'document.block.insertFieldLabel': 'Insert field',
  'document.block.insertFieldTitle': 'Insert a {path} that reads the model',
  'document.block.textAriaLabel': 'Block text',
  'document.block.textPlaceholder': 'Text; {IfcProject.Name} reads the model',
  'document.block.moveUpAriaLabel': 'Move block up',
  'document.block.moveDownAriaLabel': 'Move block down',
  'document.block.removeAriaLabel': 'Remove block',
  'document.block.imageEmpty': 'No image yet',
  'document.block.imageReading': 'Reading…',
  'document.block.imageChoosePrompt': 'Choose PNG / JPEG…',
  'document.block.imageHeightAriaLabel': 'Image height',
  'document.block.alignLabel': 'Align',
  'document.block.imageAlignAriaLabel': 'Image alignment',
  'document.block.alignLeft': 'Left',
  'document.block.alignCenter': 'Center',
  'document.block.alignRight': 'Right',
  'document.block.captionPlaceholder': 'Caption',
  'document.block.imageCaptionAriaLabel': 'Image caption',
  'document.block.chartSelectAriaLabel': 'Chart from a dashboard',
  'document.block.chartSelectTitle': 'Copy a chart from one of the saved dashboards',
  'document.block.chartReplaceOption': '{title} — replace with…',
  'document.block.chartSnapshotLabel': '3D snapshot',
  'document.block.topicSourceLabel': 'Topic',
  'document.block.topicNotLoaded': '{guid} (not loaded)',
  'document.block.pickTopicOption': 'Pick a topic…',
  'document.block.topicSnapshotLabel': 'Viewpoint snapshot',
  'document.block.imageReadError': 'Could not read the image',

  // DocumentPanel.tsx (#4918 doc slice): the "Add block" menu (a sibling
  // to the existing addBlock.spacer key).
  'document.addBlock.text': 'Text with fields',
  'document.addBlock.image': 'Image / logo',
  'document.addBlock.chart': 'Chart',
  'document.addBlock.topic': 'BCF topic',
  'document.addBlock.topicDisabledTitle': 'No BCF topics loaded',
  'document.addBlock.button': 'Add block',
  'document.addBlock.buttonTitle': 'Add a block to the page',
  'document.addBlock.spacer': 'Spacer',

  // DocumentPanel.tsx (#4918 doc slice): the panel's own header controls,
  // export action, empty state, and the toasts its export/save flow raises.
  'document.panel.selectAriaLabel': 'Document',
  'document.panel.pageLabel': 'Page',
  'document.panel.pageSizeAriaLabel': 'Page size',
  'document.panel.pageSizeA4': 'A4',
  'document.panel.pageSizeA3': 'A3',
  'document.panel.orientationAriaLabel': 'Orientation',
  'document.panel.orientationPortrait': 'Portrait',
  'document.panel.orientationLandscape': 'Landscape',
  'document.panel.exportTitle': 'Print this page to a PDF',
  'document.panel.exportBusy': 'Exporting…',
  'document.panel.exportIdle': 'Export PDF',
  'document.panel.closeAriaLabel': 'Close document panel',
  'document.panel.emptyBlocks': 'No blocks yet — "Add block" above.',
  'document.panel.unsavedWarning':
    'The document could not be saved in this browser (storage blocked or full). Export it as a template before you reload.',
  'document.panel.exportFailedWithMessage': 'Document export failed: {message}',
  'document.panel.exportFailedGeneric': 'Document export failed',
  'document.panel.exportSuccess': {
    one: 'Document exported: {countDisplay} page',
    other: 'Document exported: {countDisplay} pages',
  },
  'document.panel.exportSuccessWithProblems': {
    one: 'Document exported: {countDisplay} page ({problems})',
    other: 'Document exported: {countDisplay} pages ({problems})',
  },
  'document.panel.problemUnresolved': {
    one: '{countDisplay} binding unresolved',
    other: '{countDisplay} bindings unresolved',
  },
  'document.panel.problemMissingTopics': {
    one: '{countDisplay} topic not loaded',
    other: '{countDisplay} topics not loaded',
  },
  'document.panel.problemSnapshotFailures': {
    one: '{countDisplay} snapshot unavailable',
    other: '{countDisplay} snapshots unavailable',
  },
  'document.panel.problemImageFailures': {
    one: '{countDisplay} image unavailable',
    other: '{countDisplay} images unavailable',
  },
  'document.panel.problemTables': {
    one: '{countDisplay} table not printed',
    other: '{countDisplay} tables not printed',
  },

  // DocumentPreview.tsx (#4918 doc slice): empty-state and unresolved-topic
  // messages the rendered page itself shows.
  'document.preview.chartEmpty': 'No data for this chart.',
  'document.preview.textEmpty': '(empty)',
  'document.preview.imageEmpty': 'No image yet',
  'document.preview.topicNotLoaded': 'BCF topic {guid} is not among the loaded topics.',
  'document.preview.emptyPage': 'An empty page — add a block on the left.',

  // Table block (#5142): TableBlockEditor.tsx, TablePreview.tsx, DocumentPanel.tsx.
  'document.addBlock.table': 'Table (from a list)',
  'document.block.tableReplaceAriaLabel': 'List this table prints',
  'document.block.tableReplaceOption': '{name} — replace with…',
  'document.block.tableSavedGroup': 'Saved lists',
  'document.block.tablePresetGroup': 'Presets',
  'document.block.tableUpdateFromSaved': 'Update from saved list',
  'document.block.tableSavedNewer': 'The saved list changed since this copy was taken',
  'document.block.tableEditInLists': 'Edit in Lists',
  'document.block.tableEditInListsHint': 'Opened in the Lists panel — save there, then "Update from saved list" here.',
  'document.block.tableSelectionDropped': 'The selection this list was made from is not kept in a document: the table prints every element the list\'s classes and conditions match.',
  'document.block.tableTitleAriaLabel': 'Table title',
  'document.block.tableCaptionAriaLabel': 'Table caption',
  'document.block.tableRowsLabel': 'Rows',
  'document.block.tableRowsAriaLabel': 'Rows to print before "… n more rows"',
  'document.block.tableSummary': '{columns} columns · {view}',
  'document.block.tableViewFlat': 'one row per element',
  'document.block.tableViewGrouped': 'grouped with subtotals',
  'document.block.tableViewSchedule': 'schedule (one row per group)',
  'document.block.tableManyColumns': 'More than 10 columns: cells will be cut on a portrait page.',
  'document.table.resolving': 'Running the list…',
  'document.table.noModel': 'Load a model to fill this table.',
  'document.table.noRows': 'No rows match this list.',
  'document.table.error': 'The list could not be run.',
  'document.table.moreRows': {
    one: '… {countDisplay} more row',
    other: '… {countDisplay} more rows',
  },
  'document.table.total': 'Total ({count})',
  'document.panel.exportPreparingTables': 'Running lists…',

  // IDS report block (#5125): BlockEditor.tsx, IdsReportPreview.tsx, DocumentPanel.tsx.
  // A summary of checked/passed/failed and the top-level check list, mirroring
  // the table block's structure; no nested per-rule breakdown (see `ids-report.ts`).
  'document.block.kindIdsReport': 'IDS report',
  'document.addBlock.idsReport': 'IDS validation report',
  'document.addBlock.idsReportDisabledTitle': 'Run an IDS validation first',
  'document.block.idsReportSourceLabel': 'Source',
  'document.block.idsReportRefresh': 'Refresh from current validation report',
  'document.block.idsReportRefreshDisabledTitle': 'Run an IDS validation first',
  'document.block.idsReportRefreshed': 'Refreshed from the current validation report',
  'document.preview.idsReportChecked': 'Checked',
  'document.preview.idsReportPassed': 'Passed',
  'document.preview.idsReportFailed': 'Failed',
  'document.preview.idsReportPassRate': 'Pass rate',
  'document.preview.idsReportChecksCount': {
    one: '{countDisplay} check',
    other: '{countDisplay} checks',
  },
  'document.preview.idsReportNoChecks': 'No checks in this report.',
} as const satisfies Record<string, TranslationValue>;
