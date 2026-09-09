/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshTransferRequest, MeshTransferPlan } from './scan/transfer-types';
import type { ScanRegistrationRequest, ScanRegistrationReport } from './scan/types';

import type { IfcAttributeValue, NewEntity } from '@ifc-lite/mutations';

/** Canonical planner wire edits, shared by worker transport and atomic application. */
export interface AppearanceEntityPlan {
  sourceRevision: string;
  nextExpressId: number;
  created: Array<Pick<NewEntity, 'expressId' | 'type' | 'attributes'>>;
  edits: Array<{ expressId: number; index: number; value: IfcAttributeValue }>;
  removed: number[];
}

export type AppearanceMapping =
  | { kind: 'existingUv'; scale: [number, number]; offset: [number, number]; rotationRadians: number }
  | { kind: 'planar'; frame: 'item' | 'world'; origin: [number, number, number];
      axisU: [number, number, number]; axisV: [number, number, number]; metresPerTile: [number, number] }
  | { kind: 'box'; frame: 'item' | 'world'; origin: [number, number, number]; metresPerTile: [number, number, number] };
export interface AppearanceRequest {
  /** Explicit conversion consent; omitted preserves the existing direct-only policy. */
  representationPolicy?: 'preserve' | 'evaluatedOccurrence';
  schema: 'IFC4' | 'IFC4X3';
  sourceRevision: string;
  nextExpressId: number;
  productIds: number[];
  imageUri: string;
  repeatS: boolean;
  repeatT: boolean;
  mapping: AppearanceMapping;
}
export interface AppearancePlan extends AppearanceEntityPlan {
  /** Original renderer provenance for opted-in occurrence-local Body conversions. */
  conversions?: Array<{ productId: number; representationId: number; sourceGeometryItemId: number;
    geometryItemId: number; sourceIndices: number[] }>;
  nextAvailableExpressId: number;
  items: Array<{
    productId: number;
    geometryItemId: number;
    /** Source IFC coordinates (bottom-left origin), before corner expansion. */
    texCoords: Array<[number, number]>;
    /** One-based source triangle-corner indices, before winding correction. */
    texCoordIndex: Array<[number, number, number]>;
    /** Final canonical source index layout after placement and welding. */
    sourceIndices: number[];
    /** Final target topology becomes provenance after Apply, including changed UV seams. */
    targetIndices: number[];
    /** Final canonical vertex pool, including unused slots left by triangle cleanup. */
    targetVertexCount: number;
    /** UV pairs in canonical triangle-corner order, before fragment remapping. */
    previewCornerUvs: number[];
    /** Canonical target shading normals in renderer Y-up triangle-corner order. */
    targetCornerNormals: number[];
  }>;
  exclusions: Array<{ productId: number; reason: string }>;
}
export interface AppearanceCatalogRequest {
  schema: 'IFC4' | 'IFC4X3';
  sourceRevision: string;
  productIds: number[];
}
export interface AppearanceCatalog {
  sourceRevision: string;
  products: Array<{ productId: number; ifcClass: string; typeIds: number[] }>;
  types: Array<{ typeId: number; ifcClass: string; Name: string | null }>;
  missingProductIds: number[];
}
export interface AppearanceRaster {
  width: number;
  height: number;
  byteOffset: number;
  byteLength: number;
}
export interface PageAppearanceRequest {
  appearance: AppearanceRequest;
  page: AppearanceRaster;
  sourceImages: Array<{ imageUri: string; raster: AppearanceRaster }>;
  texelsPerMetre: number;
}
export interface PageAppearancePlan {
  plan: AppearancePlan;
  itemImages: Array<{ geometryItemId: number; imageUri: string }>;
  assets: Array<{ imageUri: string; width: number; height: number; png: Uint8Array }>;
  texelsPerMetre: number;
}
/** Generic registered-image frame. IFC Z-up metres, bottom-left origin. */
export interface AnnotationPlaneFrame {
  origin: [number, number, number];
  axisU: [number, number, number];
  axisV: [number, number, number];
  sizeMetres: [number, number];
}
export interface AnnotationPlaneRequest {
  schema: 'IFC4' | 'IFC4X3'; sourceRevision: string; nextExpressId: number;
  containerId: number; GlobalId: string; containmentGlobalId: string;
  Name: string; imageUri: string; frame: AnnotationPlaneFrame;
}
export interface AnnotationPlanePlan {
  plan: AppearancePlan;
  annotationId: number;
  geometryItemId: number;
  coordinateSpace: 'ifc-z-up';
  rtcOffset: [number, number, number];
  frame: AnnotationPlaneFrame;
  /** Native canonical MeshData: geometry is Z-up, UVs already top-down for GPU.
   * Convert axes once; never flip these UVs again. */
  mesh: {
    express_id: number; ifc_type: string; global_id?: string; name?: string;
    geometry_item_id: number; positions: number[]; normals: number[];
    indices: number[]; uvs: number[]; color: [number, number, number, number];
    origin?: [number, number, number];
    texture: { texture_id: number; url: string; width: number; height: number;
      repeat_s: boolean; repeat_t: boolean };
  };
}
export interface CapturedMeshRequest extends Omit<AnnotationPlaneRequest, 'frame'> {
  /** Original sampler; omitted means non-repeating. */
  repeatS?: boolean;
  repeatT?: boolean;
  mesh: {
    /** IFC world Z-up metres. Triangle and UV indices are zero-based. */
    positions: [number, number, number][];
    triangles: [number, number, number][];
    /** IFC V-up UVs; the returned canonical mesh already uses GPU top-down UVs. */
    uvs: [number, number][];
    uvTriangles: [number, number, number][];
  };
}
export interface CapturedMeshPlan extends Omit<AnnotationPlanePlan, 'annotationId' | 'frame'> {
  objectId: number;
}
export type AppearanceWorkerJob =
  | { type: 'mesh-transfer'; request: MeshTransferRequest; rgba: Uint8Array }
  | { type: 'scan-registration'; request: ScanRegistrationRequest }
  | { type: 'captured-mesh-plan'; request: CapturedMeshRequest }
  | { type: 'annotation-plan'; request: AnnotationPlaneRequest }
  | { type: 'plan'; request: AppearanceRequest }
  | { type: 'catalog'; request: AppearanceCatalogRequest }
  | { type: 'page-plan'; request: PageAppearanceRequest; rgba: Uint8Array };
export type AppearanceWorkerRequest = AppearanceWorkerJob & { id: number; source: Uint8Array };
export type AppearanceWorkerResponse =
  | { type: 'mesh-transfer-complete'; id: number; result: MeshTransferPlan }
  | { type: 'scan-registration-complete'; id: number; result: ScanRegistrationReport }
  | { type: 'captured-mesh-complete'; id: number; result: CapturedMeshPlan }
  | { type: 'annotation-complete'; id: number; result: AnnotationPlanePlan }
  | { type: 'complete'; id: number; plan: AppearancePlan }
  | { type: 'catalog-complete'; id: number; catalog: AppearanceCatalog }
  | { type: 'page-complete'; id: number; result: PageAppearancePlan }
  | { type: 'error'; id: number; message: string };
