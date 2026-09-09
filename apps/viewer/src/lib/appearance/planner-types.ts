/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
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
export type AppearanceWorkerJob =
  | { type: 'plan'; request: AppearanceRequest }
  | { type: 'catalog'; request: AppearanceCatalogRequest }
  | { type: 'page-plan'; request: PageAppearanceRequest; rgba: Uint8Array };
export type AppearanceWorkerRequest = AppearanceWorkerJob & { id: number; source: Uint8Array };
export type AppearanceWorkerResponse =
  | { type: 'complete'; id: number; plan: AppearancePlan }
  | { type: 'catalog-complete'; id: number; catalog: AppearanceCatalog }
  | { type: 'page-complete'; id: number; result: PageAppearancePlan }
  | { type: 'error'; id: number; message: string };
