/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Charts panel's own chrome (#4918 slice N): `ChartCard.tsx`'s title-bar
 * controls and empty-bucket state, `ChartEditor.tsx`'s field labels and
 * aria-labels, `ChartsPanel.tsx`'s header controls and empty states,
 * `DashboardMenu.tsx`'s dropdown items, `ElementFieldPicker.tsx`'s family/
 * set/field controls and "(unavailable)" fallbacks, and
 * `ReportExportDialog.tsx`'s page-setup dialog. Chart TITLES, dashboard
 * NAMES, field/set/column NAMES, and selector text are runtime data chosen
 * by the user, not literals, and stay out of this catalogue — same reasoning
 * as every other slice's exclusion of model/document content.
 *
 * Originally seeded by the Charts panel's Source filter field (#4946):
 * `chartEditor.sourceFilter*` / `chartCard.noSourceFilterMatches`.
 *
 * Deliberately out of scope for this slice, same incremental-slice approach
 * the rest of the sweep uses: `ChartCard.tsx`'s computed subtitle prose
 * (`subtitleFor`, `describeAggregation`, `EMPTY_HINTS`) and the `TYPE_LABELS`/
 * `SOURCE_LABELS`/`FOCUS_LABEL`/`SCOPE_LABEL`/`FAMILY_LABELS` select-option
 * data tables — none of these are hardcoded JSX text or a policed attribute
 * the `check-i18n-literals` gate flags (they are read through a variable, not
 * a literal, at their render site) — plus `DashboardMenu.tsx`'s
 * `DashboardMenu.tsx`'s toast copy and `ReportExportDialog.tsx`'s toast/error
 * copy and its `FIELDS` title-block label table, for the same reason.
 */
export const chartsEn = {
  'chartComparison.label': 'Saved comparison',
  'chartComparison.choose': 'Choose a completed saved comparison',
  'chartComparison.pending': 'Source (choose a saved comparison)',
  'chartComparison.legacy': 'Latest comparison (existing chart)',
  'chartComparison.unavailable': 'Saved comparison unavailable',
  'chartComparison.none': 'Complete and save a model comparison to use it here.',
  'chartComparison.missing': 'Saved comparison unavailable in this browser. Choose another saved comparison; the latest run is not substituted.',
  'chartComparison.recorded': 'Saved comparison: {name}. Recorded report rows; 3D selection and snapshots are unavailable.',
  // Saved clash report as a chart source (#6947): ChartSourcePicker.tsx, ChartCard.tsx, document chart captions.
  'chartClashReport.label': 'Clash report',
  'chartClashReport.current': 'Current result',
  'chartClashReport.unavailable': 'Saved clash report unavailable',
  'chartClashReport.missing': 'Saved clash report unavailable in this browser. Choose a source; the current result is not shown in its place.',
  'chartClashReport.chooseSource': 'Choose a source',
  'chartClashReport.caption': 'Saved clash report: {name}, saved {date}',
  'chartClashReport.badgePartial': 'Partial run',
  'chartClashReport.badgeStale': 'Models changed before saving',
  'chartClashReport.badgeRevision.different': 'Different model revision',
  'chartClashReport.badgeRevision.not-loaded': 'Models not loaded',
  'chartClashReport.badgeRevision.unverified': 'Revision not confirmed',
  'chartClashReport.savedSource': 'a saved clash report',
  // ChartEditor.tsx — Source filter field (#4946)
  'chartEditor.sourceFilterLabel': 'Source filter (selector)',
  'chartEditor.sourceFilterAriaLabel': 'Source filter',
  'chartEditor.sourceFilterMode': 'Source filter editor',
  'chartEditor.selectorMode': 'Selector',
  'chartEditor.rulesMode': 'Add rule',
  'chartEditor.selectorSyntaxReference': 'Selector syntax reference',
  'chartEditor.sourceFilterNotApplicable': 'Source filter is not applicable to {source}.',
  'chartCard.noSourceFilterMatches': 'No rows match this source filter.',

  // ChartCard.tsx
  'chartCard.dragToMoveTitle': 'Drag to move the card',
  'chartCard.frameTitle': 'Frame the selected buckets (or the whole chart) in 3D',
  'chartCard.frameAriaLabel': 'Frame {title}',
  'chartCard.editChartTitle': 'Edit chart',
  'chartCard.editAriaLabel': 'Edit {title}',
  'chartCard.duplicateChartTitle': 'Duplicate chart',
  'chartCard.duplicateAriaLabel': 'Duplicate {title}',
  'chartCard.copyName': '{name} (copy)',
  'chartCard.removeChartTitle': 'Remove chart',
  'chartCard.removeAriaLabel': 'Remove {title}',
  'chartCard.nothingToBucket': 'Nothing to bucket — every row is without a value for this dimension.',

  // ChartEditor.tsx — form fields
  'chartEditor.titleLabel': 'Title',
  'chartEditor.titleAriaLabel': 'Chart title',
  'chartEditor.sourceLabelEmpty': 'Source (nothing loaded for this source yet)',
  'chartEditor.sourceLabelWithCount': 'Source ({count} rows)',
  'chartEditor.sourceAriaLabel': 'Source',
  // ChartEditor.tsx — clash rule filter, `clash` source only (#5156)
  'chartEditor.clashRuleLabel': 'Clash rule',
  'chartEditor.clashRuleAriaLabel': 'Clash rule',
  'chartEditor.clashRuleAllOption': 'All rules',
  'chartEditor.chartTypeLabel': 'Chart',
  'chartEditor.chartTypeAriaLabel': 'Chart type',
  'chartEditor.groupByLabel': 'Group by',
  'chartEditor.groupByAriaLabel': 'Group by',
  'chartEditor.stackByLabel': 'Stack by',
  'chartEditor.stackByAriaLabel': 'Stack by',
  'chartEditor.measureLabel': 'Measure',
  'chartEditor.measureAriaLabel': 'Measure',
  'chartEditor.countOption': 'Count',
  'chartEditor.sumOfOption': 'Sum of {column}{unit}',
  'chartEditor.topNLabel': 'Top N (rest as Other)',
  'chartEditor.topNAriaLabel': 'Top N',
  'chartEditor.orderLabel': 'Order',
  'chartEditor.orderAriaLabel': 'Order',
  'chartEditor.orderValueOption': 'Largest first',
  'chartEditor.orderLabelOption': 'By label',
  'chartEditor.cancelButton': 'Cancel',
  'chartEditor.saveButton': 'Save chart',

  // ChartsPanel.tsx
  'chartsPanel.dashboardAriaLabel': 'Dashboard',
  'chartsPanel.scopeLabel': 'Scope',
  'chartsPanel.scopeAriaLabel': 'Scope',
  'chartsPanel.focusModeTitle': 'How a clicked bucket is shown in 3D',
  'chartsPanel.onClickLabel': 'On click',
  'chartsPanel.focusModeAriaLabel': 'Focus mode',
  'chartsPanel.colorIn3DTitle': "Colour the model by the first chart's buckets",
  'chartsPanel.colorIn3DLabel': 'Colour in 3D',
  'chartsPanel.clearSliceTitle': 'Clear the chart selection and show the whole scope again',
  'chartsPanel.clearSliceButton': 'Clear slice ({count})',
  'chartsPanel.addChartButton': 'Add chart',
  'chartsPanel.loadModelEmptyState': 'Load a model to chart it.',
  'chartsPanel.noChartsEmptyState': 'No charts yet.',
  'chartsPanel.addChartEmptyStateButton': 'Add a chart',

  // DashboardMenu.tsx
  'dashboardMenu.actionsAriaLabel': 'Dashboard actions',
  'dashboardMenu.actionsTitle': 'Rename, duplicate, delete, export or import a dashboard',
  'dashboardMenu.renameItem': 'Rename',
  'dashboardMenu.namePrompt': 'Dashboard name',
  'dashboardMenu.duplicateItem': 'Duplicate',
  'dashboardMenu.deleteItem': 'Delete',
  'dashboardMenu.exportFileItem': 'Export file…',
  'dashboardMenu.importFileItem': 'Import file…',

  // ElementFieldPicker.tsx
  'elementFieldPicker.fieldLabel': 'Element field',
  'elementFieldPicker.fieldLabelLoading': 'Element field (discovering…)',
  'elementFieldPicker.fieldSourceAriaLabel': 'Element field source',
  'elementFieldPicker.filterLabel': 'Filter',
  'elementFieldPicker.filterPlaceholder': 'Set or field name…',
  'elementFieldPicker.filterAriaLabel': 'Filter fields',
  'elementFieldPicker.attributeLabel': 'Attribute',
  'elementFieldPicker.attributeAriaLabel': 'IFC attribute',
  'elementFieldPicker.unavailableAttributeOption': '{name} (unavailable)',
  'elementFieldPicker.propertySetLabel': 'Property set',
  'elementFieldPicker.quantitySetLabel': 'Quantity set',
  'elementFieldPicker.propertySetAriaLabel': 'IFC property set',
  'elementFieldPicker.quantitySetAriaLabel': 'IFC quantity set',
  'elementFieldPicker.unavailableSetOption': '{name} (unavailable)',
  'elementFieldPicker.propertyLabel': 'Property',
  'elementFieldPicker.quantityLabel': 'Quantity',
  'elementFieldPicker.propertyAriaLabel': 'IFC property',
  'elementFieldPicker.quantityAriaLabel': 'IFC quantity',
  'elementFieldPicker.unavailableFieldOption': '{name} (unavailable)',
  'elementFieldPicker.relationLabel': 'Relation',
  'elementFieldPicker.relationAriaLabel': 'IFC relation',
  'elementFieldPicker.classificationName': 'Classification: {system}',
  'elementFieldPicker.unavailableRelationOption': '{name} (unavailable)',
  'elementFieldPicker.unavailableFieldNotice': 'This saved field is unavailable in the loaded models. It will be preserved.',

  // ReportExportDialog.tsx
  'reportExportDialog.triggerTitle': 'Print this dashboard to a PDF report',
  'reportExportDialog.triggerLabel': 'Report',
  'reportExportDialog.dialogTitle': 'Export report',
  'reportExportDialog.descriptionWithSnapshots': 'Every chart of the dashboard as a vector chart with its bucket table and a 3D snapshot of its largest bucket.',
  'reportExportDialog.descriptionWithoutSnapshots': 'Every chart of the dashboard as a vector chart with its bucket table.',
  'reportExportDialog.pageSizeLabel': 'Page',
  'reportExportDialog.pageSizeAriaLabel': 'Page size',
  'reportExportDialog.pageSizeA4': 'A4',
  'reportExportDialog.pageSizeA3': 'A3',
  'reportExportDialog.orientationLabel': 'Orientation',
  'reportExportDialog.orientationAriaLabel': 'Orientation',
  'reportExportDialog.orientationPortrait': 'Portrait',
  'reportExportDialog.orientationLandscape': 'Landscape',
  'reportExportDialog.snapshotsCheckboxLabel': "Include a 3D snapshot of each chart's largest bucket",
  'reportExportDialog.exportButton': 'Export PDF',
} as const satisfies Record<string, TranslationValue>;
