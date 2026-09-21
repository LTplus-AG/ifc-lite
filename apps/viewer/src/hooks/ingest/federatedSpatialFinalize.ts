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
import { alignGeometryToReference, extractModelSpatialPlacement, findReferenceSpatialModel, type ModelSpatialPlacement } from './federationAlign';
import { capturePreAlignment } from './federationRealign';
import { applyLandXmlRenderedLineUpdates, buildLandXmlRenderedLineUpdates } from './landXmlSpatialLines';
import type { FederatedLandXmlStreamingFinalization } from './federatedLandXmlStreaming';

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

/** Adopt only the destination render-frame metadata. Identity alignment leaves
 * this model's vertices and bounds untouched, so anchor bounds are unrelated. */
function adoptIdentityFrame(geometry: GeometryResult, destination: GeometryResult['coordinateInfo']): void {
  const info = structuredClone(geometry.coordinateInfo);
  info.originShift = structuredClone(destination.originShift);
  info.hasLargeCoordinates = destination.hasLargeCoordinates;
  for (const key of ['wasmRtcOffset', 'wasmRtcFrame', 'buildingRotation'] as const) {
    const value = destination[key];
    if (value === undefined) delete info[key];
    else Object.assign(info, { [key]: structuredClone(value) });
  }
  geometry.coordinateInfo = info;
}

function hasLandXmlSpatialRecords(document: LandXmlTinDocument | undefined): boolean {
  if (!document) return false;
  if (document.alignments.length > 0) return true;
  if (document.surfaces.some((surface) => (
    surface.boundaries.length + surface.breaklines.length + surface.contours.length > 0
  ))) return true;
  const plan = document.plan;
  return Boolean(plan && (plan.cogoPoints.some((point) => point.point)
    || plan.resolvedMonuments.some((monument) => monument.point)
    || plan.resolvedGeometry.length > 0));
}

/** Keep the streamed and aggregate federation warnings word-for-word alike. */
function reportFederationAlignmentOutcome(
  status: FederatedModel['federationAlignmentStatus'],
  fileName: string,
  source: ModelSpatialPlacement,
  reference: ModelSpatialPlacement,
): void {
  const sourceCrs = source.spatialReference.horizontal?.id ?? 'unknown CRS';
  const targetCrs = reference.spatialReference.horizontal?.id ?? 'unknown CRS';
  if (status === 'reprojected') {
    toast.info(`Reprojected "${fileName}" from ${sourceCrs} to ${targetCrs} for federation alignment.`);
  } else if (status === 'failed') {
    toast.error(`Could not align "${fileName}" with the federation anchor — ${sourceCrs} → ${targetCrs} reprojection failed. The model is shown in its own local frame and may appear at the wrong real-world position.`);
  }
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
  federatedLandXmlStreamingPlan?: FederatedLandXmlStreamingFinalization;
  isCurrent(): boolean;
  setProgress(progress: { phase: string; percent: number }): void;
}): Promise<FederatedSpatialFinalizeResult | null> {
  // #5050 has already aligned, clipped, and transaction-published every
  // component under a frozen main-thread plan. Re-running the historic
  // aggregate finalizer would both move it twice and race a second GPU upload.
  // Keep this verification here so every federated format still crosses the
  // one canonical finalization seam.
  if (options.federatedLandXmlStreamingPlan) {
    options.federatedLandXmlStreamingPlan.verify(options.geometry);
    // Geometry was aligned and installed one component at a time before this
    // common seam. Source-derived line overlays have no GPU transaction of
    // their own, so they must still cross the canonical finalizer once the
    // complete semantic document is available.
    const source = options.federatedLandXmlStreamingPlan.sourcePlacement;
    const reference = options.federatedLandXmlStreamingPlan.referencePlacement;
    if (options.landXmlDocument && source && reference) {
      const renderedLines = await buildLandXmlRenderedLineUpdates(
        options.landXmlDocument,
        source.spatialReference,
        reference.spatialReference,
        reference.coordinateInfo,
      );
      if (!options.isCurrent()) return null;
      applyLandXmlRenderedLineUpdates(renderedLines);
    }
    if (source && reference) {
      reportFederationAlignmentOutcome(
        options.federatedLandXmlStreamingPlan.federationAlignmentStatus,
        options.fileName,
        source,
        reference,
      );
    }
    return {
      preAlignment: options.federatedLandXmlStreamingPlan.preAlignment,
      federationAlignmentStatus: options.federatedLandXmlStreamingPlan.federationAlignmentStatus,
    };
  }
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
    const status = await alignGeometryToReference(options.geometry, parsed, reference, {
      allowEmptyGeometry: hasLandXmlSpatialRecords(options.landXmlDocument),
    });
    if (!options.isCurrent()) return null;
    federationAlignmentStatus = status;
    // An identity spatial transform leaves vertices untouched, but the model
    // has nevertheless entered the reference frame. Commit that frame before
    // the LandXML render-frame pass below: reframing from the old source RTC
    // would translate an already destination-relative mesh a second time.
    if (status === 'identity' && reference.coordinateInfo) {
      adoptIdentityFrame(options.geometry, reference.coordinateInfo);
    }
    if (options.landXmlDocument && (status === 'same-crs' || status === 'reprojected' || status === 'identity')) {
      const renderedLines = await buildLandXmlRenderedLineUpdates(
        options.landXmlDocument,
        parsed.spatialReference, reference.spatialReference, reference.coordinateInfo,
      );
      if (!options.isCurrent()) return null;
      applyLandXmlRenderedLineUpdates(renderedLines);
    }
    reportFederationAlignmentOutcome(status, options.fileName, parsed, reference);
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
