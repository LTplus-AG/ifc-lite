/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What IFC export can and cannot do with the LandXML models currently in
 * scope (#4937).
 *
 * Until v1 of the mapping, `canExportIfc` was a blanket `false` for any
 * LandXML source. It is now "the loaded records are covered by the mapping",
 * which is a question with three answers, not two: fully covered, covered in
 * part, or not covered at all. §6 of
 * `docs/architecture/landxml-to-ifc-mapping.md` requires that the middle case
 * still export while stating, by record family and before the user commits,
 * what will be left out — a silent partial is the one outcome the mapping
 * rules out.
 *
 * The plan is computed WITHOUT building the file: `collectRefusals` and
 * `isMappableSurface` read the parsed document directly, so the dialog can
 * show it on every keystroke of the model selector.
 */

import {
  alignmentMappingOf, alignmentRefusalMessage, collectRefusals, isMappableSurface,
  type LandXmlIfcSource, type LandXmlRefusal, type RefusedAlignment,
} from '@ifc-lite/create';
import type { FederatedModel } from '@/store';
import { isLandXmlSchema, type LandXmlTinDocument } from '@/hooks/ingest/landXmlSemantics.js';

/**
 * The viewer's parsed document IS the converter's input.
 *
 * `@ifc-lite/create` deliberately declares its own structural input type
 * rather than importing this one, so that the converter is testable without
 * the viewer. This assignment is where the two meet; if the shapes ever
 * diverge, it stops compiling here rather than silently at run time.
 */
export function landXmlIfcSource(document: LandXmlTinDocument): LandXmlIfcSource {
  return document;
}

export interface LandXmlExportPlan {
  /** `selected` — the chosen model is LandXML. `merged` — one of the models in a merged export is. */
  scope: 'selected' | 'merged';
  /** Every model in scope carries at least one record the mapping writes, AND the conversion is offered. */
  covered: boolean;
  /**
   * The records are covered, but the scope is a merge, which v1 cannot do.
   * Distinct from "not covered": the fix is the scope, not the file.
   */
  mergedUnsupported: boolean;
  surfaces: number;
  surveyPoints: number;
  /** Horizontal alignments the mapping will write as `IfcAlignment` (§11). */
  alignments: number;
  /** Out-of-scope families across every LandXML model in scope. */
  refusals: LandXmlRefusal[];
  /** True when any model in scope was scaled by an operator-supplied unit (§2.1). */
  assumedUnit: string | null;
  /** True when no model in scope declares a coordinate reference system (§4.2). */
  missingCrs: boolean;
  /**
   * The declared horizontal datum, written as `IfcProjectedCRS.Name`.
   *
   * Its presence is also why the transposition check (§2.2, §9.1) cannot run:
   * that check needs the CRS's easting/northing BOUNDS, and ifc-lite
   * deliberately does not resolve a datum name to them — §4.2 forbids the
   * crate from resolving EPSG codes, and guessing bounds from a name is the
   * producer-sniffing §2.2 rejects. A declared CRS therefore means "written,
   * but unverified", which the dialog states rather than leaving implied.
   */
  crsName: string | null;
}

function isLandXmlModel(model: { sourceSchema?: string }): boolean {
  return model.sourceSchema !== undefined && isLandXmlSchema(model.sourceSchema);
}

/**
 * Merge refusal rows of the same family across several models into one row.
 *
 * The alignments row is the exception to "keep the first sentence": it names
 * each refused alignment and why, so it is rebuilt from every document's
 * refusals. Keeping the first document's sentence under a summed count named
 * one alignment while counting two (#5370 review).
 */
function mergeRefusals(all: LandXmlRefusal[][], refusedAlignments: readonly RefusedAlignment[]): LandXmlRefusal[] {
  const byFamily = new Map<string, LandXmlRefusal>();
  for (const refusal of all.flat()) {
    const existing = byFamily.get(refusal.family);
    if (!existing) {
      byFamily.set(refusal.family, { ...refusal });
      continue;
    }
    // Keep the first model's sentence but sum the counts: the reason a family
    // is out of scope does not vary by model, and two rows for one family read
    // as two different problems.
    existing.count += refusal.count;
  }
  const alignments = byFamily.get('alignments');
  if (alignments) alignments.message = alignmentRefusalMessage(refusedAlignments);
  return [...byFamily.values()];
}

/**
 * The plan for the current selection, or `null` when no LandXML model is in
 * scope and IFC export is an ordinary IFC-to-IFC export.
 */
export function landXmlExportPlan(
  models: ReadonlyMap<string, FederatedModel>,
  selectedModel: { sourceSchema?: string; landXmlDocument?: LandXmlTinDocument } | undefined,
  mergedScope: boolean,
): LandXmlExportPlan | null {
  const inScope: LandXmlTinDocument[] = [];
  let scope: 'selected' | 'merged' | null = null;

  if (selectedModel && isLandXmlModel(selectedModel)) {
    scope = 'selected';
    if (selectedModel.landXmlDocument) inScope.push(selectedModel.landXmlDocument);
  }
  if (mergedScope) {
    for (const model of models.values()) {
      if (!isLandXmlModel(model)) continue;
      scope ??= 'merged';
      const document = model.landXmlDocument;
      // A merged export that already includes the selected model must not
      // count its records twice.
      if (document && !inScope.includes(document)) inScope.push(document);
    }
  }
  if (scope === null) return null;

  let surfaces = 0;
  let surveyPoints = 0;
  let alignments = 0;
  let assumedUnit: string | null = null;
  let missingCrs = false;
  let crsName: string | null = null;
  const refusals: LandXmlRefusal[][] = [];
  const refusedAlignments: RefusedAlignment[] = [];

  for (const document of inScope) {
    // A document with no resolved units cannot be scaled to metres at all, so
    // none of its records are writable whatever else it holds (§2.1).
    const source = landXmlIfcSource(document);
    // Mapped once, so the count shown and the refusal list agree with each
    // other — and with the export, which runs the same mapping.
    const alignmentMapping = alignmentMappingOf(source);
    if (document.units !== null) {
      surfaces += document.surfaces.filter(isMappableSurface).length;
      surveyPoints += (document.plan?.cogoPoints ?? []).filter((point) => point.point !== null).length;
      alignments += alignmentMapping.mapped.length;
      if (document.units.assumed) assumedUnit ??= document.units.linearUnit;
    }
    const datum = document.coordinateSystem?.horizontalDatum;
    if (datum) crsName ??= datum;
    else missingCrs = true;
    refusals.push(collectRefusals(source, alignmentMapping));
    refusedAlignments.push(...alignmentMapping.refused);
  }

  // A LandXML model whose document has not been retained (a cache-restored
  // session) has nothing provably writable, and claiming coverage we cannot
  // deliver is the failure §6 forbids.
  const hasRecords = inScope.length > 0 && (surfaces > 0 || surveyPoints > 0 || alignments > 0);

  return {
    scope,
    // v1 converts ONE LandXML document into a standalone IFC4X3 file. It is
    // not a merge participant: `MergedExporter` consumes `IfcDataStore`s and a
    // LandXML model has none, so a merged scope containing one still refuses
    // rather than silently dropping either side of the merge.
    mergedUnsupported: mergedScope && hasRecords,
    covered: hasRecords && !mergedScope,
    surfaces,
    surveyPoints,
    alignments,
    refusals: mergeRefusals(refusals, refusedAlignments),
    assumedUnit,
    missingCrs,
    crsName,
  };
}
