/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Frozen, main-thread-owned federation plan for streamed LandXML meshes. */

import type { CoordinateInfo, GeometryResult, MeshData, ModelSpatialReference } from '@ifc-lite/geometry';
import type { PreAlignmentSnapshot } from '../../store/types.js';
import { totalYupOffset } from '@ifc-lite/geometry/world-frame';
import { createCoordinateInfo, createEmptyBounds, type Bounds3D } from '../../utils/localParsingUtils.js';
import { findReferenceSpatialModel, type FederationAlignmentStatus, type ModelSpatialPlacement } from './federationAlign.js';
import { alignLandXmlComponent } from './federationComponentAlignment.js';
import { boundsFitRenderFrame, deriveLandXmlRenderFrameFromMeasurement, meshRenderFrameBounds, type LandXmlRenderFramePlan } from './landXmlRenderFrame.js';
import { LandXmlProvisionalTransaction, type LandXmlFederationReservation, type LandXmlProvisionalResources } from './landXmlProvisionalTransaction.js';

export interface FederatedLandXmlStreamingFinalization {
  readonly coordinateInfo: CoordinateInfo;
  readonly federationAlignmentStatus: FederationAlignmentStatus | 'anchor' | 'none';
  readonly sourcePlacement: ModelSpatialPlacement | null;
  readonly referencePlacement: ModelSpatialPlacement | null;
  readonly preAlignment: PreAlignmentSnapshot;
  verify(geometry: GeometryResult): void;
}

interface FederatedLandXmlStreamingOptions {
  modelId: string;
  componentCount: number;
  sourceCoordinateInfo: CoordinateInfo;
  spatialReference?: ModelSpatialReference;
  registry: LandXmlFederationReservation;
  resources: LandXmlProvisionalResources;
  isCurrent(): boolean;
}

function mergeBounds(target: Bounds3D, source: Bounds3D): void {
  target.min.x = Math.min(target.min.x, source.min.x);
  target.min.y = Math.min(target.min.y, source.min.y);
  target.min.z = Math.min(target.min.z, source.min.z);
  target.max.x = Math.max(target.max.x, source.max.x);
  target.max.y = Math.max(target.max.y, source.max.y);
  target.max.z = Math.max(target.max.z, source.max.z);
}

/**
 * The first pass owns only one mesh at a time.  It runs the canonical
 * one-mesh adapter to measure the *destination* frame; pass two repeats that
 * same operation before publishing the component and acknowledging the worker.
 */
export class FederatedLandXmlStreamingPlan implements FederatedLandXmlStreamingFinalization {
  private readonly source: ModelSpatialPlacement | null;
  private readonly reference = findReferenceSpatialModel()?.placement ?? null;
  private readonly measuredBounds = createEmptyBounds();
  private dominant: { bounds: Bounds3D; triangles: number } | null = null;
  private measured = 0;
  private transaction: LandXmlProvisionalTransaction | null = null;
  private frame: LandXmlRenderFramePlan | null = null;
  private retained: MeshData[] = [];
  private readonly sourceMeshes: MeshData[] = [];
  private consumed = 0;
  private frozen = false;
  private completed = false;
  private alignmentStatus: FederatedLandXmlStreamingFinalization['federationAlignmentStatus'];
  coordinateInfo: CoordinateInfo;

  constructor(private readonly options: FederatedLandXmlStreamingOptions) {
    this.source = options.spatialReference
      ? { spatialReference: options.spatialReference, coordinateInfo: options.sourceCoordinateInfo }
      : null;
    this.alignmentStatus = this.reference && this.source ? 'identity' : this.source ? 'anchor' : 'none';
    this.coordinateInfo = structuredClone(options.sourceCoordinateInfo);
  }

  get federationAlignmentStatus(): FederatedLandXmlStreamingFinalization['federationAlignmentStatus'] {
    return this.alignmentStatus;
  }

  get sourcePlacement(): ModelSpatialPlacement | null { return this.source; }

  get referencePlacement(): ModelSpatialPlacement | null { return this.reference; }

  get preAlignment(): PreAlignmentSnapshot {
    return {
      positions: this.sourceMeshes.map((mesh) => new Float32Array(mesh.positions)),
      normals: this.sourceMeshes.map((mesh) => new Float32Array(mesh.normals)),
      origins: this.sourceMeshes.map((mesh) => mesh.origin ? [...mesh.origin] as [number, number, number] : undefined),
      geometryAabbs: this.sourceMeshes.map((mesh) => mesh.geometryAabb),
      coordinateInfo: structuredClone(this.options.sourceCoordinateInfo),
      instancedGeometryAabbs: undefined,
    };
  }

  /** Main-thread acknowledgement for one pass-one source component. */
  async measure(mesh: MeshData): Promise<void> {
    this.assertCurrent();
    if (this.frozen) throw new Error('LandXML federation preflight arrived after its destination frame froze');
    const aligned = await this.align(mesh);
    const bounds = meshRenderFrameBounds(aligned);
    if (bounds === null) throw new Error('LandXML federation preflight produced non-finite component bounds');
    mergeBounds(this.measuredBounds, bounds);
    const triangles = aligned.indices.length / 3;
    // Match the direct LandXML frame policy: the first source component wins
    // a triangle-count tie, rather than letting the aggregate envelope choose
    // a distant, non-renderable origin.
    if (this.dominant === null || triangles > this.dominant.triangles) {
      this.dominant = { bounds, triangles };
    }
    this.measured++;
  }

  /** Freeze the exact destination render frame before the worker starts pass two. */
  freeze(): void {
    this.assertCurrent();
    if (this.frozen) throw new Error('LandXML federation destination frame was frozen twice');
    if (this.measured !== this.options.componentCount) {
      throw new Error('LandXML federation preflight did not reproduce its component envelope');
    }
    // A federated stream enters the anchor's already-frozen render frame. The
    // one-component adapter below produces coordinates relative to that frame,
    // so selecting a second "dominant" LandXML origin here would shift the
    // input twice and discard anchor RTC/building metadata.
    if (this.reference?.coordinateInfo) {
      this.frame = { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: this.reference.coordinateInfo.hasLargeCoordinates };
      this.coordinateInfo = structuredClone(this.reference.coordinateInfo);
    } else {
      const dominant = this.dominant;
      if (dominant === null) throw new Error('LandXML federation preflight froze without a measured component');
      this.frame = deriveLandXmlRenderFrameFromMeasurement(this.measuredBounds, dominant.bounds);
      this.coordinateInfo = createCoordinateInfo(this.measuredBounds, this.frame.originShift, this.frame.hasLargeCoordinates);
    }
    this.transaction = new LandXmlProvisionalTransaction(
      this.options.modelId,
      this.options.componentCount,
      this.frame,
      this.options.registry,
      this.options.resources,
    );
    this.frozen = true;
  }

  /** Main-thread publication for one raw pass-two component. */
  async publish(mesh: MeshData): Promise<void> {
    this.assertCurrent();
    if (!this.frozen || this.frame === null || this.transaction === null) {
      throw new Error('LandXML federation component arrived before its destination frame froze');
    }
    const source = {
      ...mesh,
      positions: new Float32Array(mesh.positions),
      normals: new Float32Array(mesh.normals),
      ...(mesh.origin ? { origin: [...mesh.origin] as [number, number, number] } : {}),
      ...(mesh.geometryAabb ? { geometryAabb: structuredClone(mesh.geometryAabb) } : {}),
    };
    const aligned = await this.align(mesh);
    const bounds = meshRenderFrameBounds(aligned);
    if (bounds === null || !boundsFitRenderFrame(bounds, this.frame.originShift)) {
      this.transaction.skip(aligned);
      this.consumed++;
      return;
    }
    const origin = aligned.origin ?? [0, 0, 0];
    aligned.origin = [
      origin[0] - this.frame.originShift.x,
      origin[1] - this.frame.originShift.y,
      origin[2] - this.frame.originShift.z,
    ];
    this.transaction.publish(aligned);
    this.retained.push(aligned);
    this.sourceMeshes.push(source);
    this.consumed++;
  }

  /** Install the already-published meshes into the eventual model payload. */
  complete(geometry: GeometryResult): void {
    this.assertCurrent();
    if (!this.frozen || this.transaction === null || this.completed) {
      throw new Error('LandXML federation stream completed without an open destination plan');
    }
    if (this.consumed !== this.options.componentCount) {
      throw new Error('LandXML second pass did not reproduce its federation component envelope');
    }
    this.transaction.commit();
    geometry.meshes = this.retained;
    geometry.totalVertices = this.retained.reduce((total, mesh) => total + mesh.positions.length / 3, 0);
    geometry.totalTriangles = this.retained.reduce((total, mesh) => total + mesh.indices.length / 3, 0);
    geometry.coordinateInfo = structuredClone(this.coordinateInfo);
    this.completed = true;
  }

  rollback(): void {
    this.transaction?.rollback();
    this.retained = [];
    this.sourceMeshes.length = 0;
  }

  verify(geometry: GeometryResult): void {
    if (!this.completed || geometry.coordinateInfo.originShift.x !== this.coordinateInfo.originShift.x
      || geometry.coordinateInfo.originShift.y !== this.coordinateInfo.originShift.y
      || geometry.coordinateInfo.originShift.z !== this.coordinateInfo.originShift.z) {
      throw new Error('LandXML federation finalization received a geometry result outside its frozen destination frame');
    }
  }

  private async align(mesh: MeshData): Promise<MeshData> {
    if (this.source && this.reference) {
      const aligned = await alignLandXmlComponent(mesh, this.options.sourceCoordinateInfo, this.source, this.reference);
      this.alignmentStatus = aligned.status;
      if (aligned.status !== 'failed') return aligned.mesh;
      return mesh;
    }
    // Unknown-CRS LandXML still uses the federation render origin. This is
    // the same offset-only operation used by normal federation finalization;
    // it does not claim geographic equivalence or manufacture a new frame.
    if (this.reference?.coordinateInfo) {
      const own = totalYupOffset(this.options.sourceCoordinateInfo);
      const target = totalYupOffset(this.reference.coordinateInfo);
      const origin = mesh.origin ?? [0, 0, 0];
      mesh.origin = [origin[0] + own.x - target.x, origin[1] + own.y - target.y, origin[2] + own.z - target.z];
    }
    return mesh;
  }

  private assertCurrent(): void {
    if (!this.options.isCurrent()) throw new Error('LandXML parsing cancelled');
  }
}
