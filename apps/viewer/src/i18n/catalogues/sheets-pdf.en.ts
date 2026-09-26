/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The sheet/title-block and PDF-view catalogue (#4918 sheets/PDF slice):
 * `TitleBlockEditor.tsx` (`sheetsPdf.titleBlock.*`), `SheetSetupPanel.tsx`
 * (`sheetsPdf.sheetSetup.*`), and the to-scale 3D-view PDF export dialog's
 * three files — `PdfViewExportDialog.tsx`, `PdfViewAppearanceSection.tsx`,
 * `PdfViewPageNotices.tsx` (`sheetsPdf.pdfView.*`). Split into one
 * namespace per owning surface in a single file purely to keep three small
 * sibling components from spawning three near-empty catalogue files.
 *
 * Title-block FIELD VALUES the user types (project name, drawing number,
 * revision descriptions, initials, …) and field LABELS (either a preset
 * from `@ifc-lite/drawing-2d` or a custom label the user chose) are model
 * content, never catalogued — only interpolated as params (`fieldPlaceholder`,
 * `byAuthor`). Paper size NAMES (`A0`, `Letter`, …), millimetre/dpi figures,
 * and the `mm`/`dpi` unit strings stay literal inside their templates per
 * the house rule on units and symbols; only the sentence around them is
 * translated. `describeShadingResolution` (a plain function, not a
 * component) takes the same `t: typeof resolve = resolve` default
 * parameter shape `bulk-property-value.ts` and `WebGpuTroubleshooting.tsx`
 * use, so its two sentences stay locale-aware without a hook. The page-size
 * and oversize readouts in `PdfViewPageNotices.tsx` were fixed-fragment
 * concatenations (`'Estimated page: ' + w + ' x ' + h + ...`); each is now
 * one complete message per branch (fits/no-ISO-match/unavailable) rather
 * than assembled from translated pieces, the same reasoning the layers and
 * clash-tools catalogues already document for a multi-clause status line.
 */
export const sheetsPdfEn = {
  // TitleBlockEditor
  'sheetsPdf.titleBlock.dialogTitle': 'Edit Title Block',
  'sheetsPdf.titleBlock.standardFieldsHeading': 'Standard Fields',
  'sheetsPdf.titleBlock.fieldPlaceholder': 'Enter {label}...',
  'sheetsPdf.titleBlock.customFieldsHeading': 'Custom Fields',
  'sheetsPdf.titleBlock.addFieldButton': 'Add Field',
  'sheetsPdf.titleBlock.fieldLabelPlaceholder': 'Field label...',
  'sheetsPdf.titleBlock.addButton': 'Add',
  'sheetsPdf.titleBlock.cancel': 'Cancel',
  'sheetsPdf.titleBlock.noCustomFields': 'No custom fields yet',
  'sheetsPdf.titleBlock.companyLogoHeading': 'Company Logo',
  'sheetsPdf.titleBlock.logoAlt': 'Logo',
  'sheetsPdf.titleBlock.removeLogo': 'Remove',
  'sheetsPdf.titleBlock.uploadLogo': 'Upload Logo',
  'sheetsPdf.titleBlock.logoFormats': 'PNG, JPG, or SVG',
  'sheetsPdf.titleBlock.revisionHistoryHeading': 'Revision History',
  'sheetsPdf.titleBlock.addRevisionButton': 'Add Revision',
  'sheetsPdf.titleBlock.revisionNumberLabel': 'Rev #',
  'sheetsPdf.titleBlock.revisionNumberPlaceholder': 'A, B, 01...',
  'sheetsPdf.titleBlock.dateLabel': 'Date',
  'sheetsPdf.titleBlock.datePlaceholder': '2024-01-15',
  'sheetsPdf.titleBlock.descriptionLabel': 'Description',
  'sheetsPdf.titleBlock.descriptionPlaceholder': 'Description of changes...',
  'sheetsPdf.titleBlock.authorLabel': 'Author',
  'sheetsPdf.titleBlock.authorPlaceholder': 'Initials...',
  'sheetsPdf.titleBlock.noRevisions': 'No revisions yet',
  'sheetsPdf.titleBlock.byAuthor': 'by {author}',
  'sheetsPdf.titleBlock.done': 'Done',

  // SheetSetupPanel
  'sheetsPdf.sheetSetup.enabledToggleLabel': 'Sheet enabled',
  'sheetsPdf.sheetSetup.enablePrompt': 'Enable drawing sheet to configure paper size, frame, and title block.',
  'sheetsPdf.sheetSetup.enableButton': 'Enable Sheet',
  'sheetsPdf.sheetSetup.paperSizeHeading': 'Paper Size',
  'sheetsPdf.sheetSetup.paperOption': '{name} ({width}×{height}mm)',
  'sheetsPdf.sheetSetup.paperDimensions': '{width} × {height} mm',
  'sheetsPdf.sheetSetup.frameStyleHeading': 'Frame Style',
  'sheetsPdf.sheetSetup.frameStyleSimple': 'Simple',
  'sheetsPdf.sheetSetup.frameStyleProfessional': 'Professional',
  'sheetsPdf.sheetSetup.frameStyleMinimal': 'Minimal',
  'sheetsPdf.sheetSetup.frameStyleIso': 'ISO Standard',
  'sheetsPdf.sheetSetup.margins': 'Margins: {top}/{right}/{bottom}/{left}mm',
  'sheetsPdf.sheetSetup.drawingScaleHeading': 'Drawing Scale',
  'sheetsPdf.sheetSetup.titleBlockHeading': 'Title Block',
  'sheetsPdf.sheetSetup.layoutLabel': 'Layout',
  'sheetsPdf.sheetSetup.layoutStandard': 'Standard (Bottom Right)',
  'sheetsPdf.sheetSetup.layoutExtended': 'Extended (Full Width)',
  'sheetsPdf.sheetSetup.layoutCompact': 'Compact (Smaller)',
  'sheetsPdf.sheetSetup.titleBlockDimensions': '{width} × {height}mm',
  'sheetsPdf.sheetSetup.fieldsConfigured': '{count} fields configured',
  'sheetsPdf.sheetSetup.editTitleBlockFieldsButton': 'Edit Title Block Fields',
  'sheetsPdf.sheetSetup.scaleBarNorthArrowHeading': 'Scale Bar & North Arrow',
  'sheetsPdf.sheetSetup.scaleBarLabel': 'Scale Bar',
  'sheetsPdf.sheetSetup.northArrowLabel': 'North Arrow',
  'sheetsPdf.sheetSetup.savedTemplatesHeading': 'Saved Templates',
  'sheetsPdf.sheetSetup.templateNamePlaceholder': 'Template name...',
  'sheetsPdf.sheetSetup.noSavedTemplates': 'No saved templates',
  'sheetsPdf.sheetSetup.loadTemplate': 'Load template {name}',
  'sheetsPdf.sheetSetup.deleteTemplate': 'Delete template {name}',
  'sheetsPdf.sheetSetup.drawingAreaLabel': 'Drawing Area:',
  'sheetsPdf.sheetSetup.drawingAreaValue': '{width} × {height} mm',
  'sheetsPdf.sheetSetup.scaleLabel': 'Scale:',

  // PdfViewAppearanceSection
  'sheetsPdf.pdfView.appearanceLabel': 'Appearance',
  'sheetsPdf.pdfView.shadedOption': 'Shaded surfaces',
  'sheetsPdf.pdfView.lineWorkOption': 'Line work only',
  'sheetsPdf.pdfView.appearanceNoteShaded': 'Surfaces print in their model colours, shaded the way the 3D viewport shows them. The line work on top stays vector, so the sheet is still measurable.',
  'sheetsPdf.pdfView.appearanceNoteLineWork': 'Monochrome line work only. No fills, materials, textures or point clouds.',
  'sheetsPdf.pdfView.shadingResolution': 'Shading resolution: {dpi} dpi.',
  'sheetsPdf.pdfView.shadingResolutionCapped': 'Shading resolution: {dpi} dpi (reduced from {maxDpi} to keep the image within memory limits). Line work stays vector and exact.',
  'sheetsPdf.pdfView.hiddenEdgesLabel': 'Show hidden edges as dashed lines',
  'sheetsPdf.pdfView.hiddenEdgesNoteShaded': 'Hidden edges apply to the line work mode. The shaded image already hides occluded surfaces.',
  'sheetsPdf.pdfView.hiddenEdgesNoteOn': 'Edges behind other geometry print as dashed lines.',
  'sheetsPdf.pdfView.hiddenEdgesNoteOff': 'Only edges you can actually see are printed.',
  'sheetsPdf.pdfView.scaleStampLabel': 'Print a scale bar and the scale on the sheet',
  'sheetsPdf.pdfView.scaleStampNoteOn': 'A scale bar and the text "Scale {scaleLabel}" print in a band below the drawing, which makes the page slightly taller. The bar is drawn to scale, so it stays correct on a photocopy that the printed ratio no longer describes.',
  'sheetsPdf.pdfView.scaleStampNoteOff': 'The sheet carries no scale of its own. Only do this if it goes into a title block that states the scale, because a print nobody can check invites measuring it at the wrong one.',

  // PdfViewExportDialog
  'sheetsPdf.pdfView.exportPdfButton': 'Export PDF',
  'sheetsPdf.pdfView.dialogTitle': 'Export PDF (to-scale 3D view)',
  'sheetsPdf.pdfView.dialogDescription': 'Saves everything currently visible, projected along your current view direction at an exact scale. Shaded surfaces are embedded as an image placed at exact size; all line work stays vector, so measurements taken off the print are correct.',
  'sheetsPdf.pdfView.scaleLabel': 'Scale',
  'sheetsPdf.pdfView.displayedScaleOption': 'As displayed (about 1:{scale})',
  'sheetsPdf.pdfView.displayedScaleUnavailable': 'As displayed (not available)',
  'sheetsPdf.pdfView.customOption': 'Custom',
  'sheetsPdf.pdfView.customScaleError': 'Enter a whole number greater than zero, for example 75.',
  'sheetsPdf.pdfView.sectionCutNote': 'The active section cut is applied. Cut edges print with a heavy line weight.',
  'sheetsPdf.pdfView.cancelButton': 'Cancel',
  'sheetsPdf.pdfView.exportingLabel': 'Exporting...',
  'sheetsPdf.pdfView.exportButton': 'Export',
  'sheetsPdf.pdfView.exportPhasePreparing': 'Preparing',
  'sheetsPdf.pdfView.exportSuccessToast': 'Exported 1:{scale} PDF, page {width} x {height} mm',
  'sheetsPdf.pdfView.exportFailedWithMessage': 'PDF export failed: {message}',
  'sheetsPdf.pdfView.exportFailedGeneric': 'PDF export failed.',
  // Dialog closes on success (`ExportDialogShell`'s `closeOnSuccess`, #5848),
  // so `successTitle` is passed for prop-completeness but never actually
  // renders; `errorTitle` does, alongside the existing toast.
  'sheetsPdf.pdfView.successTitle': 'Success',
  'sheetsPdf.pdfView.errorTitle': 'Error',

  // PdfViewPageNotices
  'sheetsPdf.pdfView.pageReadoutFits': 'Estimated page: {width} x {height} mm (fits {paperName}). The exported page is sized to the drawing itself and will never be larger.',
  'sheetsPdf.pdfView.pageReadoutOversizeIso': 'Estimated page: {width} x {height} mm (larger than any ISO sheet). The exported page is sized to the drawing itself and will never be larger.',
  'sheetsPdf.pdfView.pageReadoutUnavailable': 'Page size is not available yet. Load a model and choose a valid scale.',
  'sheetsPdf.pdfView.oversizeTitle': 'Page too large to print',
  'sheetsPdf.pdfView.oversizeDescription': 'This scale needs a page of {width} x {height} mm. A PDF page cannot exceed {maxDimension} mm on a side. Choose a smaller scale.',
  'sheetsPdf.pdfView.perspectiveTitle': 'Perspective camera',
  'sheetsPdf.pdfView.perspectiveDescription': 'The PDF is an orthographic (parallel) projection along your current view direction, so near and far objects print at the same scale. That is the only way a printed drawing can carry a single scale. Switch to orthographic to see the same parallel projection on screen.',
  'sheetsPdf.pdfView.switchToOrthographicButton': 'Switch camera to orthographic',
  'sheetsPdf.pdfView.orthographicNote': 'Orthographic camera, so the printed scale is exact. The sheet covers everything currently visible, not only the part framed on screen: panning and zooming change what you look at, not what is printed.',
  'sheetsPdf.titleBlock.removeFieldLabel': 'Remove field {label}',
  'sheetsPdf.titleBlock.removeRevisionLabel': 'Remove revision {revision}',
} as const satisfies Record<string, TranslationValue>;
