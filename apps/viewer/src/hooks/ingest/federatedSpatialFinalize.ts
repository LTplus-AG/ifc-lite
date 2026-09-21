/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import { type GeometryResult, type ModelSpatialReference } from '@ifc-lite/geometry';
import { federationFrameInfo } from '@ifc-lite/geometry/world-frame';
import type { FederatedModel, PreAlignmentSnapshot } from '@/store';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import type { LandXmlTinDocument } from './landXmlSemantics';
import { reframeLandXmlGeometry } from './landXmlLoad';
import { alignGeometryToReference, extractModelSpatialPlacement, findReferenceSpatialModel } from './federationAlign';
import { capturePreAlignment } from './federationRealign';
import { applyLandXmlRenderedLineUpdates, buildLandXmlRenderedLineUpdates } from './landXmlSpatialLines';

export interface FederatedSpatialFinalizeResult {
  preAlignment?: PreAlignmentSnapshot;
  federationAlignmentStatus: FederatedModel['federationAlignmentStatus'];
}

/** Keep the index-aligned restore baseline in lock-step with reframe clipping. */
function retainSnapshotMeshes(
  snapshot: PreAlignmentSnapshot | undefined,
  beforeReframe: GeometryResult['meshes'],
  retained: GeometryResult['meshes'],
): PreAlignmentSnapshot | undefined {
  if (!snapshot || beforeReframe.length === retained.length) return snapshot;
  const live = new Set(retained);
  const keep = (_: unknown, index: number) => index >= beforeReframe.length || live.has(beforeReframe[index]);
  return {
    ...snapshot,
    positions: snapshot.positions.filter(keep),
    normals: snapshot.normals.filter(keep),
    origins: snapshot.origins.filter(keep),
    geometryAabbs: snapshot.geometryAabbs.filter(keep),
  };
}

/** Apply the one source-neutral placement path before IDs become globally visible. */
export async function finalizeFederatedSpatialPlacement(options: {
  dataStore: IfcDataStore;
  geometry: GeometryResult;
  modelId: string;
  fileName: string;
  spatialReference?: ModelSpatialReference;
  landXmlDocument?: LandXmlTinDocument;
  postAlignmentReframe?: boolean;
  isCurrent(): boolean;
  setProgress(progress: { phase: string; percent: number }): void;
}): Promise<FederatedSpatialFinalizeResult | null> {
  const reference = findReferenceSpatialModel()?.placement ?? null;
  const mutation = useViewerStore.getState().georefMutations.get(options.modelId);
  const parsed = options.spatialReference
    ? { spatialReference: options.spatialReference, coordinateInfo: options.geometry.coordinateInfo }
    : extractModelSpatialPlacement(options.dataStore, options.geometry.coordinateInfo, mutation);
  let preAlignment: PreAlignmentSnapshot | undefined;
  let federationAlignmentStatus: FederatedModel['federationAlignmentStatus'] = 'none';
  if (reference && parsed) {
    options.setProgress({ phase: 'Aligning georeferenced model', percent: 90 });
    preAlignment = capturePreAlignment(options.geometry);
    const status = await alignGeometryToReference(options.geometry, parsed, reference);
    if (!options.isCurrent()) return null;
    federationAlignmentStatus = status;
    if (options.landXmlDocument && (status === 'same-crs' || status === 'reprojected')) {
      const renderedLines = await buildLandXmlRenderedLineUpdates(
        options.landXmlDocument,
        parsed.spatialReference, reference.spatialReference, reference.coordinateInfo,
      );
      if (!options.isCurrent()) return null;
      applyLandXmlRenderedLineUpdates(renderedLines);
    }
    const source = parsed.spatialReference.horizontal?.id ?? 'unknown CRS';
    const target = reference.spatialReference.horizontal?.id ?? 'unknown CRS';
    if (status === 'reprojected') {
      toast.info(`Reprojected "${options.fileName}" from ${source} to ${target} for federation alignment.`);
    } else if (status === 'failed') {
      toast.error(`Could not align "${options.fileName}" with the federation anchor — ${source} → ${target} reprojection failed. The model is shown in its own local frame and may appear at the wrong real-world position.`);
    }
  } else if (parsed) {
    federationAlignmentStatus = 'anchor';
  }
  if (options.postAlignmentReframe && options.landXmlDocument) {
    // Unknown-CRS sources cannot participate in geographic alignment, but an
    // already-published render frame still has to be shared so absolute survey
    // coordinates retain their separation without exceeding the GPU frame.
    // This is a render-origin operation only: it never claims CRS equivalence.
    const renderFrame = reference?.coordinateInfo
      ?? federationFrameInfo(useViewerStore.getState().models.values());
    if (renderFrame) {
      const meshesBeforeReframe = options.geometry.meshes.slice();
      const warnings = reframeLandXmlGeometry(options.geometry, options.landXmlDocument, renderFrame);
      // `reframeLandXmlGeometry` may clip components. The baseline captured
      // before spatial alignment is index-addressed, so retain exactly the
      // slots for surviving mesh objects; otherwise the next anchor switch
      // restores mesh N from dropped mesh N-1.
      preAlignment = retainSnapshotMeshes(preAlignment, meshesBeforeReframe, options.geometry.meshes);
      for (const warning of warnings) toast.info(warning);
    }
  }
  return { preAlignment, federationAlignmentStatus };
}
