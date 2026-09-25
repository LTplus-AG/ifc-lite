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

import type { LandXmlIfcOptions } from '@ifc-lite/create';
import { buildExportFilename, downloadBlob, stripExtension } from './download.js';
import { landXmlIfcSource } from './landXmlIfcPlan.js';
import { landXmlToIfcArchive, type AppearancePlanRunner } from './landXmlIfcImagery.js';
import { createAppearancePlanner } from '@/lib/appearance/planner-worker-client.js';
import type { LandXmlTinDocument } from '@/hooks/ingest/landXmlSemantics.js';
import type { TerrainImageryDrape } from '@/lib/terrain-imagery/drape-state.js';
import type { UseTranslationResult } from '@/i18n';

export interface LandXmlIfcDownloadInput {
  document: LandXmlTinDocument;
  /** The model's display name; seeds the filename and the file's provenance. */
  name: string;
  /** Imagery draped on the terrain (#5942); written when it came from a file. */
  imagery?: TerrainImageryDrape;
  /** The appearance planner; the browser's worker unless a caller supplies one. */
  planAppearance?: AppearancePlanRunner;
}

export type LandXmlIfcDownloadResult =
  | {
    status: 'exported'; filename: string; surfaces: number; surveyPoints: number; alignments: number;
    imagery: { status: 'exported'; entryName: string } | { status: 'none' } | { status: 'refused'; reason: string };
  }
  | { status: 'refused'; reason: string };

/** The browser's planner: the appearance worker, one job, then released. */
const workerPlanner: AppearancePlanRunner = async (source, request) => {
  const planner = createAppearancePlanner();
  try {
    return await planner.plan(source, request);
  } finally {
    planner.dispose();
  }
};

/**
 * Convert one LandXML document and download it: `.ifc`, or `.ifczip` when its
 * draped imagery is written beside it (mapping spec §15.5).
 *
 * The refusal branch is returned rather than thrown: a source the mapping does
 * not cover is an answer, not a fault, and the caller shows its reason. The
 * plan should already have ruled this out, so reaching it means the document
 * changed under the dialog — still worth reporting truthfully rather than
 * writing an empty file.
 */
export async function downloadLandXmlAsIfc(input: LandXmlIfcDownloadInput): Promise<LandXmlIfcDownloadResult> {
  // The declared datum is passed through verbatim as `IfcProjectedCRS.Name`,
  // never resolved (§4.2). No `Bounds` accompany it, so the transposition
  // check does not run — see `crsName` in `landXmlIfcPlan.ts` for why, and the
  // dialog says so before the user commits.
  const datum = input.document.coordinateSystem?.horizontalDatum;
  const options: LandXmlIfcOptions = {
    sourceFileName: input.name,
    ...(datum ? { crs: { Name: datum, VerticalDatum: input.document.coordinateSystem?.verticalDatum } } : {}),
  };
  const stem = stripExtension(input.name) || 'landxml';
  const result = await landXmlToIfcArchive(
    input.document, landXmlIfcSource(input.document), options, `${stem}.ifc`,
    input.imagery, input.planAppearance ?? workerPlanner,
  );
  if (result.status === 'refused') return result;
  const filename = buildExportFilename(stem, result.extension);
  downloadBlob(
    typeof result.content === 'string'
      ? new Blob([result.content], { type: 'application/x-step' })
      : new Blob([result.content.slice()], { type: 'application/zip' }),
    filename,
  );
  return {
    status: 'exported', filename, imagery: result.imagery,
    surfaces: result.surfaces, surveyPoints: result.surveyPoints, alignments: result.alignments,
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
export async function finishLandXmlIfcExport(input: LandXmlIfcDownloadInput, ui: LandXmlIfcExportUi): Promise<void> {
  try {
    const result = await downloadLandXmlAsIfc(input);
    if (result.status === 'refused') {
      ui.setExportResult({ success: false, message: result.reason });
      return;
    }
    const records = [
      ...(result.surfaces > 0 ? [ui.t('exportDialog.landXml.convertSurfaces', { count: result.surfaces })] : []),
      ...(result.surveyPoints > 0 ? [ui.t('exportDialog.landXml.convertPoints', { count: result.surveyPoints })] : []),
      ...(result.alignments > 0 ? [ui.t('exportDialog.landXml.convertAlignments', { count: result.alignments })] : []),
    ].join(', ');
    const imagery = result.imagery.status === 'exported'
      ? ` ${ui.t('exportDialog.landXml.imageryExported', { entry: result.imagery.entryName })}`
      : result.imagery.status === 'refused'
        ? ` ${ui.t('exportDialog.landXml.imageryRefused', { reason: result.imagery.reason })}`
        : '';
    ui.setExportResult({ success: true, message: ui.t('exportDialog.landXml.exported', { records }) + imagery });
  } catch (error) {
    ui.setExportResult({ success: false, message: error instanceof Error ? error.message : String(error) });
  } finally {
    ui.setIsExporting(false);
  }
}
