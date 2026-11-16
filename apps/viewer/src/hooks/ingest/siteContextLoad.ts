/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `loadFile` branch for a site-context GLB (`@ifc-lite/site-context`):
 * decode it, build one category's model, and hand it to the one
 * `finalizeModel` every format goes through, with the document's spatial
 * reference so federation places it against the anchor model.
 *
 * Both ways in arrive here: a GLB the viewer fetched (one category per file)
 * and one the CLI wrote and the user dropped (every category in one file).
 * The second is split: the first category with geometry loads as this load's
 * model, every other one is dispatched as its own federated load of a
 * single-category GLB, so the two end in the same models.
 *
 * Heights: site context is in LN02 (EPSG:5728). An anchor that states another
 * vertical datum is refused here, before anything is built; one that states
 * none is placed under the shared-height assumption
 * (`siteContextVerticalPolicy`), which the model record and the card report.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult, ModelSpatialReference } from '@ifc-lite/geometry';
import { decodeSiteContextGlb, encodeSiteContextGlb, SiteContextFormatError, type SiteContextDocument, type SiteContextLayer } from '@ifc-lite/site-context';
import type { LoadTrace } from '@ifc-lite/load-trace';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { captureModelLoaded, snapshotFromGeometry } from '../../utils/loadTelemetry.js';
import { LOAD_COMPLETE } from '../modelLoadCanceller.js';
import { sourceArrayBuffer } from './sourceBuffers.js';
import { siteContextHeightRefusal } from './ifcGeorefAssumptions.js';
import { applyInitialHiddenState } from './initialHiddenState.js';
import { siteContextViewerModel, siteContextModelName, terrainPlanBox } from '@/lib/site-context/site-context-model';
import { parcelDisplayWidth } from '@/lib/site-context/parcel-outline';
import { siteContextFileName, singleCategoryDocument } from '@/lib/site-context/site-context-glb';
import { siteContextPlacementReference } from '@/lib/site-context/site-context-anchor';
import { adoptSiteContextModel } from '@/lib/site-context/site-context-arrival';
import type { SiteContextArrival } from '../modelLoadOptions.js';
import type { ViewerModelPayload } from './viewerModelIngest.js';

export interface SiteContextLoadOptions {
  buffer: ArrayBuffer | SharedArrayBuffer;
  modelId: string;
  /** The file's name: a model still called by it is renamed to its category, as a fetched one is. */
  fileName: string;
  fileSizeMB: number;
  targetKind: 'primary' | 'federated';
  totalStartTime: number;
  wasHidden: boolean;
  trace: LoadTrace;
  isStale(): boolean;
  setProgress(progress: { phase: string; percent: number }): void;
  settleLoadUi(progress?: { phase: string; percent: number } | null): void;
  onPrimary(result: ViewerModelPayload): void;
  finalize(
    dataStore: IfcDataStore,
    geometry: GeometryResult,
    schemaVersion: 'IFC4',
    patch: { loadPath: 'site-context'; spatialReference: ModelSpatialReference },
  ): Promise<void>;
  /** Start a federated load of another category's single-category GLB. */
  loadSibling(file: File, name: string): void;
  /** The fetch run this load belongs to; absent for a dropped site-context GLB. */
  arrival?: SiteContextArrival;
  onError(code: string, message: string): void;
}

/**
 * The building the core marked as the model's own (`subject`), as the record
 * the card shows: its express ids in this model, name and how it was matched.
 */
export function subjectOf(layer: SiteContextLayer): { expressIds: number[]; name: string; method: string; overlap?: number } | null {
  // Every feature marked subject: the tiles can split one building (one EGID) into several objects.
  const indices = layer.features.flatMap((feature, index) => (feature.subject === true ? [index] : []));
  if (indices.length === 0) return null;
  const feature = layer.features[indices[0]];
  const match = feature.provenance.subjectMatch;
  const method = match && typeof match === 'object' && !Array.isArray(match) && typeof match.method === 'string' ? match.method : 'unknown';
  const overlap = match && typeof match === 'object' && !Array.isArray(match) && typeof match.overlap === 'number' ? match.overlap : undefined;
  return { expressIds: indices.map((index) => index + 1), name: feature.name, method, ...(overlap !== undefined ? { overlap } : {}) };
}

const hasGeometry = (layer: SiteContextLayer): boolean =>
  layer.features.some((feature) => feature.mesh !== null && feature.mesh.indices.length > 0);

/** Why a category cannot load as a model, in the user's words. */
function emptyCategoryMessage(layer: SiteContextLayer): string {
  const reasons = layer.issues.map((issue) => issue.message).join('; ');
  return `The ${layer.kind} of this site context has no geometry${reasons ? `: ${reasons}` : '.'}`;
}

/** The anchor's declared heights, if they are not LN02, as the refusal the user reads. */
export function siteContextAnchorRefusal(anchor: ModelSpatialReference | null | undefined): string | null {
  const declared = anchor ? siteContextHeightRefusal(anchor) : null;
  if (!declared) return null;
  return `Site context heights are LN02 (EPSG:5728); the anchor model declares ${declared}. `
    + 'The two height systems are not mixed, so the site context was not loaded. '
    + 'If the model is really in LN02, correct its vertical datum in the georeference editor.';
}

/** Split `doc` into the category this load takes and the ones dispatched as siblings. */
export function planSiteContextLoad(doc: SiteContextDocument): {
  here: SiteContextLayer | null;
  siblings: SiteContextLayer[];
  empty: SiteContextLayer[];
} {
  const withGeometry = doc.layers.filter(hasGeometry);
  return {
    here: withGeometry[0] ?? null,
    siblings: withGeometry.slice(1),
    empty: doc.layers.filter((layer) => !hasGeometry(layer)),
  };
}

const halfExtent = (box: readonly [number, number, number, number]): number => Math.max(box[2] - box[0], box[3] - box[1]) / 2;

/**
 * The site radius the parcel line is drawn for: this file's own terrain box,
 * else the running request's radius, else a loaded context terrain (a dropped
 * file's parcel arrives as a sibling after its terrain), else 300 m.
 */
export function siteRadiusFor(doc: SiteContextDocument): number {
  const terrain = doc.layers.find((layer) => layer.kind === 'terrain');
  const own = terrain ? terrainPlanBox(terrain) : null;
  if (own) return halfExtent(own);
  const state = useViewerStore.getState();
  if (state.siteContextRequest) return state.siteContextRequest.radius;
  for (const record of state.siteContextModels.values()) if (record.planBox) return halfExtent(record.planBox);
  return 300;
}

export async function loadSiteContextModel(options: SiteContextLoadOptions): Promise<void> {
  const { isStale, setProgress, settleLoadUi } = options;
  const started = performance.now();
  setProgress({ phase: 'Reading site context', percent: 10 });
  try {
    const source = sourceArrayBuffer(options.buffer, 'source.arrayBuffer');
    const doc = decodeSiteContextGlb(new Uint8Array(source));
    const anchor = siteContextPlacementReference() ?? undefined;
    const refusal = siteContextAnchorRefusal(anchor);
    if (refusal) {
      options.onError('height-datum-mismatch', refusal);
      settleLoadUi();
      return;
    }
    const plan = planSiteContextLoad(doc);
    for (const layer of plan.empty) toast.info(emptyCategoryMessage(layer));
    if (!plan.here) {
      options.onError('no-geometry', plan.empty.map(emptyCategoryMessage).join(' ') || 'This site context holds no categories.');
      settleLoadUi();
      return;
    }
    if (!anchor && useViewerStore.getState().models.size > (options.targetKind === 'federated' ? 0 : 1)) {
      toast.info('No loaded model is georeferenced, so the site context is shown in its own frame, not around a model.');
    }
    // A file holding one category keeps its own bytes as the store's source; a
    // split file gives each model the single-category GLB it was loaded from.
    const own = doc.layers.length === 1 ? source : encodeSiteContextGlb(singleCategoryDocument(doc, plan.here)).slice().buffer;
    const payload = siteContextViewerModel(doc, plan.here, own, performance.now() - started, { parcelWidth: parcelDisplayWidth(siteRadiusFor(doc)) });
    if (isStale()) return;
    if (options.targetKind === 'primary') options.onPrimary(payload);
    setProgress({ phase: 'Placing site context', percent: 80 });
    await options.finalize(payload.dataStore, payload.geometryResult, 'IFC4', {
      loadPath: 'site-context', spatialReference: payload.spatialReference,
    });
    if (isStale()) return;
    const state = useViewerStore.getState();
    if (state.models.get(options.modelId)?.name === options.fileName) state.updateModel(options.modelId, { name: siteContextModelName(plan.here.kind) });
    const record = state.models.get(options.modelId);
    const heightAssumed = record?.ifcSharedVerticalDatumAssumed === true;
    const planBox = plan.here.kind === 'terrain' ? terrainPlanBox(plan.here) : null;
    const subject = plan.here.kind === 'buildings' ? subjectOf(plan.here) : null;
    state.registerSiteContextModel(options.modelId, {
      kind: plan.here.kind,
      attribution: plan.here.attribution,
      issues: plan.here.issues,
      complete: plan.here.complete,
      origin: doc.origin,
      ...(planBox ? { planBox } : {}),
      ...(heightAssumed ? { heightAssumed } : {}),
      ...(subject ? { hiddenSubject: subject } : {}),
    });
    // The model's own building, as swissBUILDINGS3D has it, would stand where
    // the model stands: it starts hidden through the ordinary per-entity hide
    // state, so the tree and the card can show it again.
    if (subject) applyInitialHiddenState(options.modelId, subject.expressIds);
    // One site context per scene, on every path: this model replaces the loaded one of its kind.
    adoptSiteContextModel(options.modelId, plan.here, options.arrival);
    if (heightAssumed) {
      toast.info('The model states no vertical datum, so its heights were taken as LN02 (EPSG:5728) to place the site context.');
    }
    if (record?.federationAlignmentStatus === 'failed') {
      toast.error('The site context could not be placed against the model\'s georeference; it is shown in its own frame.');
    }
    for (const layer of plan.siblings) {
      const bytes = encodeSiteContextGlb(singleCategoryDocument(doc, layer));
      options.loadSibling(new File([bytes.slice().buffer], siteContextFileName(layer.kind)), siteContextModelName(layer.kind));
    }
    captureModelLoaded({
      format: 'site-context', file_size_mb: Math.round(options.fileSizeMB * 100) / 100, load_target: options.targetKind,
      load_path: 'site-context', total_elapsed_ms: Math.round(performance.now() - options.totalStartTime), was_hidden: options.wasHidden,
    }, snapshotFromGeometry(options.fileSizeMB, payload.geometryResult), options.trace);
    settleLoadUi(LOAD_COMPLETE);
  } catch (error: unknown) {
    if (isStale()) return;
    console.error('[site-context] reading failed:', error);
    const code = error instanceof SiteContextFormatError ? 'format' : 'failed';
    options.onError(code, error instanceof Error ? error.message : String(error));
    settleLoadUi();
  }
}
