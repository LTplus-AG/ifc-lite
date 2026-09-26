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
import { landXmlIfcSource, type LandXmlExportPlan } from './landXmlIfcPlan.js';
import { landXmlToIfcArchive, type AppearancePlanRunner } from './landXmlIfcImagery.js';
import { createAppearancePlanner } from '@/lib/appearance/planner-worker-client.js';
import type { LandXmlTinDocument } from '@/hooks/ingest/landXmlSemantics.js';
import type { TerrainImageryDrape } from '@/lib/terrain-imagery/drape-state.js';
import type { UseTranslationResult } from '@/i18n';
import { computeFullSourceHashFromBlob } from '@/utils/sourceContentHash.js';

export interface LandXmlIfcDownloadInput {
  document: LandXmlTinDocument;
  /** The model's display name; seeds the filename and the file's provenance. */
  name: string;
  /**
   * The LandXML bytes as loaded. Hashed into `LandXML_Conversion.SourceHash`
   * (§7) with the same SHA-256 the imagery's `ImagerySourceHash` uses; absent
   * when the viewer no longer holds them, and then the hash is left empty.
   */
  source?: Blob;
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

/**
 * The conversion an export of `model` runs, or null when it is not a LandXML
 * conversion. The dialog's Output row and its export handler both read this,
 * so the container the row names is the one the handler writes (#5942).
 */
export function landXmlDownloadInput(
  plan: LandXmlExportPlan | null,
  schema: string | null | undefined,
  model: { name: string; landXmlDocument?: LandXmlTinDocument; terrainImagery?: TerrainImageryDrape; sourceFile?: Blob } | undefined,
): LandXmlIfcDownloadInput | null {
  if (!plan?.covered || schema !== 'IFC4X3' || !model?.landXmlDocument) return null;
  // `source` feeds LandXML_Conversion.SourceHash (mapping §7).
  return { document: model.landXmlDocument, name: model.name, imagery: model.terrainImagery, source: model.sourceFile };
}

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
  const sourceHash = input.source ? await computeFullSourceHashFromBlob(input.source) : null;
  const options: LandXmlIfcOptions = {
    sourceFileName: input.name,
    ...(sourceHash ? { sourceHash } : {}),
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
export async function landXmlIfcExportOutcome(
  input: LandXmlIfcDownloadInput,
  t: UseTranslationResult['t'],
): Promise<LandXmlIfcExportOutcome> {
  try {
    const result = await downloadLandXmlAsIfc(input);
    if (result.status === 'refused') {
      return { success: false, message: result.reason };
    }
    const records = [
      ...(result.surfaces > 0 ? [t('exportDialog.landXml.convertSurfaces', { count: result.surfaces })] : []),
      ...(result.surveyPoints > 0 ? [t('exportDialog.landXml.convertPoints', { count: result.surveyPoints })] : []),
      ...(result.alignments > 0 ? [t('exportDialog.landXml.convertAlignments', { count: result.alignments })] : []),
    ].join(', ');
    const imagery = result.imagery.status === 'exported'
      ? ` ${t('exportDialog.landXml.imageryExported', { entry: result.imagery.entryName })}`
      : result.imagery.status === 'refused'
        ? ` ${t('exportDialog.landXml.imageryRefused', { reason: result.imagery.reason })}`
        : '';
    return { success: true, message: t('exportDialog.landXml.exported', { records }) + imagery };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : String(error) };
  }
}
