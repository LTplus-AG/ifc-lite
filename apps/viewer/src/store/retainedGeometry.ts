/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a retained-kernel load (#7955 M2) leaves on its model. Types and one
 * predicate only: the retained implementation lives behind the
 * `@ifc-lite/viewer-retained` alias, so a default build never sets this field
 * and every check below is constant-false there.
 */

import type { TranslationKey } from '@/i18n';

/** A candidate product that has no retained geometry: refused by the kernel, or never reached. */
export interface RetainedUnpublishedRow {
  expressId: number;
  ifcType: string;
  /** One of the M1 refusal codes, or `cancelled` for a product the run never reached. */
  code: string;
  origin?: { site: string; entity?: number; cause: string };
  kernelStatus?: number;
}

/** One persistent source face of a published product (#7955 M11-F): `#item[>#via]:role`. */
export interface RetainedFaceRow {
  key: string;
  triangles: number;
  /** Display-precision area of its triangles, square metres. */
  areaM2: number;
}

export interface RetainedGeometrySummary {
  kernel: 'retained';
  /** Products the run planned (`start.candidateIds`); 0 until the engine started. */
  candidates: number;
  /** True once the engine sent its start event. `candidates` alone cannot say:
   *  a started run may legitimately plan zero products. */
  started?: boolean;
  published: number;
  /** Every candidate without geometry, refusals and cancellations alike, in arrival order. */
  refused: RetainedUnpublishedRow[];
  /** How many `refused` rows are `cancelled` (Cancel, or a run that stopped early). */
  cancelled: number;
  /** Presentation obligations the published products leave unmet (union, sorted). */
  obligationsUnmet: string[];
  /**
   * `running` while products are still arriving. At the end, `incomplete`
   * exactly when some candidate has no geometry (refused + cancelled > 0).
   * This is the explicit incomplete state; `loadState` keeps its lifecycle meaning.
   */
  completeness: 'running' | 'complete' | 'incomplete';
  /** Model-level failure (engine missing, host crash, stall), if the run ended in one. */
  failure?: string;
  /** Persistent face table per published product id (M11-F), source order. */
  faces?: Record<number, RetainedFaceRow[]>;
}

/** Kernel scope and worker lifetime depend on the open model, independently of presentation. */
export function hasRetainedGeometryModel(models: ReadonlyMap<string, { retainedGeometry?: RetainedGeometrySummary }>): boolean {
  for (const model of models.values()) if (model.retainedGeometry) return true;
  return false;
}

/** Tooltip/reason for every mesh-derived export and tool refused on a retained model. */
export const RETAINED_SHAPE_ONLY_REASON: TranslationKey = 'retainedGeometry.shapeOnlyReason';

/**
 * The one guard for mesh-derived exports and tools (GLB/USD/KMZ export,
 * measure, clash): their output would present shape-only meshes as the model.
 */
export function hasRetainedShapeOnlyModel(models: ReadonlyMap<string, { retainedGeometry?: RetainedGeometrySummary }>): boolean {
  for (const model of models.values()) if (model.retainedGeometry && (model.retainedGeometry.obligationsUnmet.length > 0
    || model.retainedGeometry.completeness !== 'complete' || model.retainedGeometry.failure
    || model.retainedGeometry.published === 0)) return true;
  return false;
}
