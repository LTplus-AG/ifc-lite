/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Frozen, main-thread-owned federation plan for streamed LandXML meshes. */

import type { CoordinateInfo, GeometryResult, MeshData, ModelSpatialReference } from '@ifc-lite/geometry';
import type { PreAlignmentSnapshot } from '../../store/types.js';
import { federationFrameInfo, totalYupOffset } from '@ifc-lite/geometry/world-frame';
import { useViewerStore } from '../../store/index.js';
import { createCoordinateInfo, createEmptyBounds, type Bounds3D } from '../../utils/localParsingUtils.js';
import { findReferenceSpatialModel, type FederationAlignmentStatus, type ModelSpatialPlacement } from './federationAlign.js';
import { alignLandXmlComponent } from './federationComponentAlignment.js';
import { boundsFitLandXmlPrecisionBatch, boundsFitRenderFrame, deriveLandXmlRenderFrameFromMeasurement, meshRenderFrameBounds, type LandXmlRenderFramePlan } from './landXmlRenderFrame.js';
import { LandXmlProvisionalTransaction, type LandXmlFederationReservation, type LandXmlProvisionalResources } from './landXmlProvisionalTransaction.js';

export interface FederatedLandXmlStreamingFinalization {
  readonly coordinateInfo: CoordinateInfo;
  readonly federationAlignmentStatus: FederationAlignmentStatus | 'anchor' | 'none';
  readonly sourcePlacement: ModelSpatialPlacement | null;
  readonly referencePlacement: ModelSpatialPlacement | null;
  readonly preAlignment: PreAlignmentSnapshot;
  verify(geometry: GeometryResult): void;
}

/** One bit per source slot, so frozen admission never retains component meshes. */
const MAX_FEDERATED_ADMISSION_BYTES = 512 * 1024;

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

function resetBounds(bounds: Bounds3D): void {
  bounds.min.x = Infinity;
  bounds.min.y = Infinity;
  bounds.min.z = Infinity;
  bounds.max.x = -Infinity;
  bounds.max.y = -Infinity;
  bounds.max.z = -Infinity;
}

/**
 * Cursor meshes carry absolute E/U/S origins.  Give federation alignment the
 * matching zero-offset frame; the durable source metadata remains on
 * `sourcePlacement` for overlays and later CRS resolution.
 */
function rawAbsoluteCoordinateInfo(source: CoordinateInfo): CoordinateInfo {
  const bounds = structuredClone(source.originalBounds);
  return {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: bounds,
    shiftedBounds: structuredClone(bounds),
    hasLargeCoordinates: source.hasLargeCoordinates,
  };
}

/**
 * The first pass owns only one mesh at a time.  It runs the canonical
 * one-mesh adapter to measure the *destination* frame; pass two repeats that
 * same operation before publishing the component and acknowledging the worker.
 */
export class FederatedLandXmlStreamingPlan implements FederatedLandXmlStreamingFinalization {
  private readonly source: ModelSpatialPlacement | null;
  private readonly rawSource: ModelSpatialPlacement | null;
  private readonly rawCoordinateInfo: CoordinateInfo;
  private readonly reference: ModelSpatialPlacement | null;
  /** Existing canonical renderer frame when no model has geographic metadata. */
  private readonly fallbackFrame: CoordinateInfo | null;
  private readonly measuredBounds = createEmptyBounds();
  /** Bounds of only those source groups which passed frozen RTE admission. */
  private readonly admittedBounds = createEmptyBounds();
  private readonly admissionRunBounds = createEmptyBounds();
  private dominant: { bounds: Bounds3D; triangles: number } | null = null;
  private measured = 0;
  private transaction: LandXmlProvisionalTransaction | null = null;
  private frame: LandXmlRenderFramePlan | null = null;
  private admission: Uint8Array | null = null;
  private admissionMeasured = 0;
  private admissionAccepted = 0;
  private admissionRunStart = 0;
  private admissionRunGroup: number | undefined;
  private lastFinishedAdmissionGroup = 0;
  private admissionRunAccepted = true;
  private admissionRunOpen = false;
  private admissionFrozen = false;
  private retained: MeshData[] = [];
  private readonly sourceMeshes: MeshData[] = [];
  private consumed = 0;
  private frozen = false;
  private completed = false;
  private alignmentStatus: FederatedLandXmlStreamingFinalization['federationAlignmentStatus'];
  coordinateInfo: CoordinateInfo;

  constructor(private readonly options: FederatedLandXmlStreamingOptions) {
    this.reference = findReferenceSpatialModel()?.placement ?? null;
    this.fallbackFrame = this.reference?.coordinateInfo
      ?? federationFrameInfo(useViewerStore.getState().models.values())
      ?? null;
    this.rawCoordinateInfo = rawAbsoluteCoordinateInfo(options.sourceCoordinateInfo);
    this.source = options.spatialReference
      ? { spatialReference: options.spatialReference, coordinateInfo: options.sourceCoordinateInfo }
      : null;
    this.rawSource = options.spatialReference
      ? { spatialReference: options.spatialReference, coordinateInfo: this.rawCoordinateInfo }
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
      coordinateInfo: structuredClone(this.rawCoordinateInfo),
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
    if (this.fallbackFrame) {
      this.frame = { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: this.fallbackFrame.hasLargeCoordinates };
      this.coordinateInfo = structuredClone(this.fallbackFrame);
    } else {
      const dominant = this.dominant;
      if (dominant === null) throw new Error('LandXML federation preflight froze without a measured component');
      this.frame = deriveLandXmlRenderFrameFromMeasurement(this.measuredBounds, dominant.bounds);
    }
    const admissionBytes = Math.ceil(this.options.componentCount / 8);
    if (admissionBytes > MAX_FEDERATED_ADMISSION_BYTES) {
      throw new Error('LandXML federation preflight exceeds the 512 KiB admission ledger limit');
    }
    this.admission = new Uint8Array(admissionBytes);
    this.frozen = true;
  }

  /**
   * Measure one post-frame candidate without retaining its mesh. Surface RTE
   * batches arrive contiguously, so one current group is sufficient to freeze
   * atomic acceptance in the fixed-size source-slot bitset.
   */
  async admit(component: { mesh: MeshData; frameGroup?: number }): Promise<void> {
    this.assertCurrent();
    if (!this.frozen || this.frame === null || this.admission === null || this.admissionFrozen) {
      throw new Error('LandXML federation admission arrived outside its frozen preflight');
    }
    if (this.admissionMeasured >= this.options.componentCount) {
      throw new Error('LandXML federation admission exceeded its source-slot envelope');
    }
    const slot = this.admissionMeasured;
    if (component.mesh.expressId !== slot + 1) {
      throw new Error('LandXML federation admission violated source-slot ordering');
    }
    if (this.admissionRunOpen && (component.frameGroup === undefined || component.frameGroup !== this.admissionRunGroup)) {
      this.finishAdmissionRun();
    }
    if (!this.admissionRunOpen) {
      if (component.frameGroup !== undefined && component.frameGroup <= this.lastFinishedAdmissionGroup) {
        throw new Error('LandXML federation admission replayed a non-contiguous source group');
      }
      this.admissionRunStart = slot;
      this.admissionRunGroup = component.frameGroup;
      this.admissionRunAccepted = true;
      this.admissionRunOpen = true;
      resetBounds(this.admissionRunBounds);
    }
    const aligned = await this.align(component.mesh);
    const bounds = meshRenderFrameBounds(aligned);
    if (bounds !== null) mergeBounds(this.admissionRunBounds, bounds);
    this.admissionRunAccepted &&= bounds !== null
      && boundsFitLandXmlPrecisionBatch(bounds)
      && boundsFitRenderFrame(bounds, this.frame.originShift);
    this.admissionMeasured++;
    // Unnamed entries are pipes: their source slot is their atomic group.
    if (component.frameGroup === undefined) this.finishAdmissionRun();
  }

  /** Freeze the deterministic source-slot ledger before the publication pass. */
  freezeAdmission(): void {
    this.assertCurrent();
    if (!this.frozen || this.admission === null || this.admissionFrozen) {
      throw new Error('LandXML federation admission was frozen in an invalid state');
    }
    this.finishAdmissionRun();
    if (this.admissionMeasured !== this.options.componentCount) {
      throw new Error('LandXML federation admission did not reproduce its component envelope');
    }
    if (this.options.componentCount > 0 && this.admissionAccepted === 0) {
      throw new Error('LandXML federation preflight rejected every render component');
    }
    if (!this.fallbackFrame) {
      this.coordinateInfo = createCoordinateInfo(
        this.admittedBounds,
        this.frame!.originShift,
        this.frame!.hasLargeCoordinates,
      );
    }
    this.transaction = new LandXmlProvisionalTransaction(
      this.options.modelId,
      this.options.componentCount,
      this.frame!,
      this.options.registry,
      this.options.resources,
    );
    this.admissionFrozen = true;
  }

  /** Main-thread publication for one raw pass-two component. */
  async publish(mesh: MeshData): Promise<void> {
    this.assertCurrent();
    if (!this.frozen || this.frame === null || this.transaction === null || !this.admissionFrozen) {
      throw new Error('LandXML federation component arrived before its destination frame froze');
    }
    if (!this.isAdmitted(this.consumed)) {
      this.transaction.skip(mesh);
      this.consumed++;
      return;
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
    if (bounds === null || !boundsFitLandXmlPrecisionBatch(bounds) || !boundsFitRenderFrame(bounds, this.frame.originShift)) {
      throw new Error('LandXML federation publication diverged from its frozen admission ledger');
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
    if (!this.frozen || this.transaction === null || !this.admissionFrozen || this.completed) {
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
    this.admission = null;
  }

  verify(geometry: GeometryResult): void {
    if (!this.completed || geometry.coordinateInfo.originShift.x !== this.coordinateInfo.originShift.x
      || geometry.coordinateInfo.originShift.y !== this.coordinateInfo.originShift.y
      || geometry.coordinateInfo.originShift.z !== this.coordinateInfo.originShift.z) {
      throw new Error('LandXML federation finalization received a geometry result outside its frozen destination frame');
    }
  }

  private async align(mesh: MeshData): Promise<MeshData> {
    if (this.rawSource && this.reference) {
      const aligned = await alignLandXmlComponent(mesh, this.rawCoordinateInfo, this.rawSource, this.reference);
      this.alignmentStatus = aligned.status;
      if (aligned.status !== 'failed') return aligned.mesh;
      return mesh;
    }
    // Unknown-CRS LandXML still uses the federation render origin. This is
    // the same offset-only operation used by normal federation finalization;
    // it does not claim geographic equivalence or manufacture a new frame.
    if (this.fallbackFrame) {
      const target = totalYupOffset(this.fallbackFrame);
      const origin = mesh.origin ?? [0, 0, 0];
      mesh.origin = [origin[0] - target.x, origin[1] - target.y, origin[2] - target.z];
    }
    return mesh;
  }

  private assertCurrent(): void {
    if (!this.options.isCurrent()) throw new Error('LandXML parsing cancelled');
  }

  private finishAdmissionRun(): void {
    if (!this.admissionRunOpen) return;
    if (this.admissionRunAccepted) {
      for (let slot = this.admissionRunStart; slot < this.admissionMeasured; slot++) {
        this.admission![slot >> 3] |= 1 << (slot & 7);
        this.admissionAccepted++;
      }
      mergeBounds(this.admittedBounds, this.admissionRunBounds);
    }
    this.admissionRunOpen = false;
    if (this.admissionRunGroup !== undefined) this.lastFinishedAdmissionGroup = this.admissionRunGroup;
    this.admissionRunGroup = undefined;
  }

  private isAdmitted(slot: number): boolean {
    const admission = this.admission;
    if (admission === null || slot < 0 || slot >= this.options.componentCount) {
      throw new Error('LandXML federation publication exceeded its frozen admission ledger');
    }
    return (admission[slot >> 3]! & (1 << (slot & 7))) !== 0;
  }
}
