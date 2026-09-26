/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Run the LandXML→IFC4X3 conversion for the export dialog and hand the result
 * to the browser (#4937).
 *
 * Separate from `landXmlIfcPlan.ts` because the plan is recomputed on every
 * render and must stay cheap, while this walks every vertex and serialises the
 * file. Separate from the dialog because the dialog is at its module-size
 * budget and because a conversion this consequential should be testable
 * without mounting React.
 */

import { landXmlToIfc, type LandXmlIfcResult } from '@ifc-lite/create';
import { buildExportFilename, downloadBlob, stripExtension } from './download.js';
import { landXmlIfcSource } from './landXmlIfcPlan.js';
import type { LandXmlTinDocument } from '@/hooks/ingest/landXmlSemantics.js';
import type { UseTranslationResult } from '@/i18n';

export interface LandXmlIfcDownloadInput {
  document: LandXmlTinDocument;
  /** The model's display name; seeds the filename and the file's provenance. */
  name: string;
}

export type LandXmlIfcDownloadResult =
  | { status: 'exported'; filename: string; surfaces: number; surveyPoints: number; alignments: number }
  | { status: 'refused'; reason: string };

/**
 * Convert one LandXML document and download it as `.ifc`.
 *
 * The refusal branch is returned rather than thrown: a source the mapping does
 * not cover is an answer, not a fault, and the caller shows its reason. The
 * plan should already have ruled this out, so reaching it means the document
 * changed under the dialog — still worth reporting truthfully rather than
 * writing an empty file.
 */
export function downloadLandXmlAsIfc(input: LandXmlIfcDownloadInput): LandXmlIfcDownloadResult {
  // The declared datum is passed through verbatim as `IfcProjectedCRS.Name`,
  // never resolved (§4.2). No `Bounds` accompany it, so the transposition
  // check does not run — see `crsName` in `landXmlIfcPlan.ts` for why, and the
  // dialog says so before the user commits.
  const datum = input.document.coordinateSystem?.horizontalDatum;
  const result: LandXmlIfcResult = landXmlToIfc(landXmlIfcSource(input.document), {
    sourceFileName: input.name,
    ...(datum ? { crs: { Name: datum, VerticalDatum: input.document.coordinateSystem?.verticalDatum } } : {}),
  });
  if (result.status === 'refused') {
    return { status: 'refused', reason: result.reason };
  }
  const filename = buildExportFilename(stripExtension(input.name) || 'landxml', '.ifc');
  downloadBlob(new Blob([result.content], { type: 'application/x-step' }), filename);
  return {
    status: 'exported',
    filename,
    surfaces: result.coverage.surfaces,
    surveyPoints: result.coverage.surveyPoints,
    alignments: result.coverage.alignments ?? 0,
  };
}

/** The outcome an `ExportDialogShell.onExport` (or equivalent) renders. */
export interface LandXmlIfcExportOutcome {
  success: boolean;
  message: string;
}

/**
 * Convert, download, and report — the whole LandXML branch of the dialog's
 * export handler, so the dialog itself keeps one call.
 *
 * Pure with respect to dialog state (#5848): the caller owns `isExporting`
 * and the rendered result (the shell does, for `ExportDialog.tsx`), so this
 * only returns the outcome rather than pushing it into setters itself.
 */
export function landXmlIfcExportOutcome(
  input: LandXmlIfcDownloadInput,
  t: UseTranslationResult['t'],
): LandXmlIfcExportOutcome {
  try {
    const result = downloadLandXmlAsIfc(input);
    if (result.status === 'refused') {
      return { success: false, message: result.reason };
    }
    const records = [
      ...(result.surfaces > 0 ? [t('exportDialog.landXml.convertSurfaces', { count: result.surfaces })] : []),
      ...(result.surveyPoints > 0 ? [t('exportDialog.landXml.convertPoints', { count: result.surveyPoints })] : []),
      ...(result.alignments > 0 ? [t('exportDialog.landXml.convertAlignments', { count: result.alignments })] : []),
    ].join(', ');
    return { success: true, message: t('exportDialog.landXml.exported', { records }) };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : String(error) };
  }
}
