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

/** The dialog's result/toast handling for a LandXML conversion. */
export interface LandXmlIfcExportUi {
  t: UseTranslationResult['t'];
  setExportResult: (result: { success: boolean; message: string }) => void;
  setIsExporting: (exporting: boolean) => void;
}

/**
 * Convert, download, and report — the whole LandXML branch of the dialog's
 * export handler, so the dialog itself keeps one call.
 *
 * `setIsExporting(false)` happens here rather than in the caller's `finally`
 * because this branch returns early from it; leaving that to the caller is how
 * the dialog would end up stuck on "Exporting...".
 */
export function finishLandXmlIfcExport(input: LandXmlIfcDownloadInput, ui: LandXmlIfcExportUi): boolean {
  try {
    const result = downloadLandXmlAsIfc(input);
    if (result.status === 'refused') {
      ui.setExportResult({ success: false, message: result.reason });
      return false;
    }
    const records = [
      ...(result.surfaces > 0 ? [ui.t('exportDialog.landXml.convertSurfaces', { count: result.surfaces })] : []),
      ...(result.surveyPoints > 0 ? [ui.t('exportDialog.landXml.convertPoints', { count: result.surveyPoints })] : []),
      ...(result.alignments > 0 ? [ui.t('exportDialog.landXml.convertAlignments', { count: result.alignments })] : []),
    ].join(', ');
    ui.setExportResult({ success: true, message: ui.t('exportDialog.landXml.exported', { records }) });
    return true;
  } catch (error) {
    ui.setExportResult({ success: false, message: error instanceof Error ? error.message : String(error) });
    return false;
  } finally {
    ui.setIsExporting(false);
  }
}
