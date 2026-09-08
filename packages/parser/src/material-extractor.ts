/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Material Extractor
 *
 * Extracts IFC material definitions and associations.
 *
 * Material concepts in IFC:
 * - IfcMaterial: Basic material (concrete, steel, wood, etc.)
 * - IfcMaterialLayer: Material with thickness (e.g., in walls)
 * - IfcMaterialLayerSet: Set of layers (e.g., multi-layer wall)
 * - IfcMaterialProfile: Material with profile shape
 * - IfcMaterialProfileSet: Set of profiles (e.g., structural members)
 * - IfcMaterialConstituent: Material as part of a composite
 * - IfcMaterialConstituentSet: Set of constituents
 * - IfcRelAssociatesMaterial: Associates materials with elements
 */

import type { IfcEntity } from './entity-extractor.js';
import { getString, getNumber, getReference, getReferences } from './attribute-helpers.js';
import {
  LAYER_THICKNESS_SLOT,
  extractMaterialLayer,
  extractMaterialLayerSet,
  hasUnrepresentableThickness,
} from './material-layer-reader.js';
import type { MaterialLayer, MaterialLayerSet } from './material-layer-reader.js';

export type { MaterialLayer, MaterialLayerSet } from './material-layer-reader.js';

export interface Material {
  id: number;
  name: string;
  description?: string;
  category?: string;
}

export interface MaterialProfile {
  id: number;
  name?: string;
  description?: string;
  material?: number;  // Material ID
  profile?: number;   // Profile ID
  priority?: number;
  category?: string;
}

export interface MaterialProfileSet {
  id: number;
  name?: string;
  description?: string;
  profiles: number[];  // MaterialProfile IDs
}

export interface MaterialConstituent {
  id: number;
  name?: string;
  description?: string;
  material: number;  // Material ID
  fraction?: number;
  category?: string;
}

export interface MaterialConstituentSet {
  id: number;
  name?: string;
  description?: string;
  constituents: number[];  // MaterialConstituent IDs
}

export interface MaterialAssociation {
  relationshipId: number;
  relatingMaterialId: number;  // Material, LayerSet, ProfileSet, or ConstituentSet ID
  materialType: 'Material' | 'LayerSet' | 'ProfileSet' | 'ConstituentSet';
  relatedObjects: number[];     // Element IDs
}

export interface MaterialsData {
  materials: Map<number, Material>;
  materialLayers: Map<number, MaterialLayer>;
  materialLayerSets: Map<number, MaterialLayerSet>;
  materialProfiles: Map<number, MaterialProfile>;
  materialProfileSets: Map<number, MaterialProfileSet>;
  materialConstituents: Map<number, MaterialConstituent>;
  materialConstituentSets: Map<number, MaterialConstituentSet>;
  associations: MaterialAssociation[];
}

/**
 * Extract materials from IFC entities
 */
export function extractMaterials(
  entities: Map<number, IfcEntity>,
  entitiesByType: Map<string, number[]>
): MaterialsData {
  const data: MaterialsData = {
    materials: new Map(),
    materialLayers: new Map(),
    materialLayerSets: new Map(),
    materialProfiles: new Map(),
    materialProfileSets: new Map(),
    materialConstituents: new Map(),
    materialConstituentSets: new Map(),
    associations: [],
  };

  // Extract IfcMaterial
  const materialIds = entitiesByType.get('IfcMaterial') || [];
  for (const id of materialIds) {
    const entity = entities.get(id);
    if (entity) {
      data.materials.set(id, extractMaterial(entity));
    }
  }

  // Extract IfcMaterialLayer
  const layerIds = entitiesByType.get('IfcMaterialLayer') || [];
  for (const id of layerIds) {
    const entity = entities.get(id);
    if (entity) {
      // Dropped rather than recorded with a substituted thickness. A consumer
      // that looks the layer up gets `undefined`, which it can see; a layer
      // recorded as 0 thick reads as a measurement.
      if (hasUnrepresentableThickness(entity)) {
        console.warn(
          `[material-extractor] IfcMaterialLayer #${id} LayerThickness is outside the ` +
          `IEEE-754 double range (${String(entity.attributes[LAYER_THICKNESS_SLOT])}); ` +
          `dropping the layer rather than reporting it as 0 thick.`,
        );
        continue;
      }
      data.materialLayers.set(id, extractMaterialLayer(entity));
    }
  }

  // Extract IfcMaterialLayerSet
  const layerSetIds = entitiesByType.get('IfcMaterialLayerSet') || [];
  for (const id of layerSetIds) {
    const entity = entities.get(id);
    if (entity) {
      data.materialLayerSets.set(id, extractMaterialLayerSet(entity, entities));
    }
  }

  // Extract IfcMaterialProfile
  const profileIds = entitiesByType.get('IfcMaterialProfile') || [];
  for (const id of profileIds) {
    const entity = entities.get(id);
    if (entity) {
      data.materialProfiles.set(id, extractMaterialProfile(entity, entities));
    }
  }

  // Extract IfcMaterialProfileSet
  const profileSetIds = entitiesByType.get('IfcMaterialProfileSet') || [];
  for (const id of profileSetIds) {
    const entity = entities.get(id);
    if (entity) {
      data.materialProfileSets.set(id, extractMaterialProfileSet(entity, entities));
    }
  }

  // Extract IfcMaterialConstituent
  const constituentIds = entitiesByType.get('IfcMaterialConstituent') || [];
  for (const id of constituentIds) {
    const entity = entities.get(id);
    if (entity) {
      data.materialConstituents.set(id, extractMaterialConstituent(entity, entities));
    }
  }

  // Extract IfcMaterialConstituentSet
  const constituentSetIds = entitiesByType.get('IfcMaterialConstituentSet') || [];
  for (const id of constituentSetIds) {
    const entity = entities.get(id);
    if (entity) {
      data.materialConstituentSets.set(id, extractMaterialConstituentSet(entity, entities));
    }
  }

  // Extract IfcRelAssociatesMaterial relationships
  const relIds = entitiesByType.get('IfcRelAssociatesMaterial') || [];
  for (const id of relIds) {
    const entity = entities.get(id);
    if (entity) {
      const association = extractMaterialAssociation(entity, entities);
      if (association) {
        data.associations.push(association);
      }
    }
  }

  return data;
}

function extractMaterial(entity: IfcEntity): Material {
  return {
    id: entity.expressId,
    name: getString(entity.attributes[0]) || '',
    description: getString(entity.attributes[1]),
    category: getString(entity.attributes[2]),
  };
}

function extractMaterialProfile(
  entity: IfcEntity,
  entities: Map<number, IfcEntity>
): MaterialProfile {
  return {
    id: entity.expressId,
    name: getString(entity.attributes[0]),
    description: getString(entity.attributes[1]),
    material: getReference(entity.attributes[2]),
    profile: getReference(entity.attributes[3]),
    priority: getNumber(entity.attributes[4]),
    category: getString(entity.attributes[5]),
  };
}

function extractMaterialProfileSet(
  entity: IfcEntity,
  entities: Map<number, IfcEntity>
): MaterialProfileSet {
  return {
    id: entity.expressId,
    name: getString(entity.attributes[0]),
    description: getString(entity.attributes[1]),
    profiles: getReferences(entity.attributes[2]) || [],
  };
}

function extractMaterialConstituent(
  entity: IfcEntity,
  entities: Map<number, IfcEntity>
): MaterialConstituent {
  return {
    id: entity.expressId,
    name: getString(entity.attributes[0]),
    description: getString(entity.attributes[1]),
    material: getReference(entity.attributes[2]) || 0,
    fraction: getNumber(entity.attributes[3]),
    category: getString(entity.attributes[4]),
  };
}

function extractMaterialConstituentSet(
  entity: IfcEntity,
  entities: Map<number, IfcEntity>
): MaterialConstituentSet {
  return {
    id: entity.expressId,
    name: getString(entity.attributes[0]),
    description: getString(entity.attributes[1]),
    constituents: getReferences(entity.attributes[2]) || [],
  };
}

function extractMaterialAssociation(
  entity: IfcEntity,
  entities: Map<number, IfcEntity>
): MaterialAssociation | null {
  // IfcRelAssociatesMaterial attributes:
  // [0] GlobalId
  // [1] OwnerHistory
  // [2] Name
  // [3] Description
  // [4] RelatedObjects (list of elements)
  // [5] RelatingMaterial (Material, LayerSet, ProfileSet, or ConstituentSet)

  const relatedObjects = getReferences(entity.attributes[4]) || [];
  const relatingMaterialRef = getReference(entity.attributes[5]);

  if (!relatingMaterialRef) {
    return null;
  }

  const materialEntity = entities.get(relatingMaterialRef);
  if (!materialEntity) {
    return null;
  }

  // Determine material type
  let materialType: 'Material' | 'LayerSet' | 'ProfileSet' | 'ConstituentSet' = 'Material';
  if (materialEntity.type === 'IfcMaterialLayerSet') {
    materialType = 'LayerSet';
  } else if (materialEntity.type === 'IfcMaterialProfileSet') {
    materialType = 'ProfileSet';
  } else if (materialEntity.type === 'IfcMaterialConstituentSet') {
    materialType = 'ConstituentSet';
  }

  return {
    relationshipId: entity.expressId,
    relatingMaterialId: relatingMaterialRef,
    materialType,
    relatedObjects,
  };
}

/**
 * Get material for an element
 */
export function getMaterialForElement(
  elementId: number,
  materialsData: MaterialsData
): number | undefined {
  // Find association for this element
  for (const assoc of materialsData.associations) {
    if (assoc.relatedObjects.includes(elementId)) {
      return assoc.relatingMaterialId;
    }
  }
  return undefined;
}

/**
 * Get material name for an element
 */
export function getMaterialNameForElement(
  elementId: number,
  materialsData: MaterialsData
): string | undefined {
  const materialId = getMaterialForElement(elementId, materialsData);
  if (!materialId) return undefined;

  // Check if it's a simple material
  const material = materialsData.materials.get(materialId);
  if (material) return material.name;

  // Check if it's a layer set
  const layerSet = materialsData.materialLayerSets.get(materialId);
  if (layerSet) return layerSet.name;

  // Check if it's a profile set
  const profileSet = materialsData.materialProfileSets.get(materialId);
  if (profileSet) return profileSet.name;

  // Check if it's a constituent set
  const constituentSet = materialsData.materialConstituentSets.get(materialId);
  if (constituentSet) return constituentSet.name;

  return undefined;
}
