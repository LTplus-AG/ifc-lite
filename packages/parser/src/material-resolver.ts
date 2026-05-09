/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Material resolution — extracts and resolves IFC material assignments
 * including layers, profiles, constituents, lists, and *Usage indirection.
 * Includes cycle detection for recursive material references.
 */

import { EntityExtractor } from './entity-extractor.js';
import { RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';

export interface MaterialInfo {
    type: 'Material' | 'MaterialLayerSet' | 'MaterialProfileSet' | 'MaterialConstituentSet' | 'MaterialList';
    name?: string;
    description?: string;
    /** IfcMaterial.Category (IFC4+). */
    category?: string;
    layers?: MaterialLayerInfo[];
    profiles?: MaterialProfileInfo[];
    constituents?: MaterialConstituentInfo[];
    materials?: string[];
}

export interface MaterialLayerInfo {
    materialName?: string;
    thickness?: number;
    isVentilated?: boolean;
    name?: string;
    /** IfcMaterialLayer.Category. */
    category?: string;
    /** IfcMaterial.Category — surfaced separately so IDS material checks
     * can match either the layer's own category or the underlying material's. */
    materialCategory?: string;
}

export interface MaterialProfileInfo {
    materialName?: string;
    name?: string;
    /** IfcMaterialProfile.Category. */
    category?: string;
    /** IfcMaterial.Category — see above. */
    materialCategory?: string;
}

export interface MaterialConstituentInfo {
    materialName?: string;
    name?: string;
    fraction?: number;
    /** IfcMaterialConstituent.Category. */
    category?: string;
    /** IfcMaterial.Category — see above. */
    materialCategory?: string;
}

/**
 * Extract materials for a single entity ON-DEMAND.
 * Uses the onDemandMaterialMap built during parsing.
 * Falls back to relationship graph when on-demand map is not available (e.g., server-loaded models).
 * Also checks type-level material assignments via IfcRelDefinesByType.
 * Resolves the full material structure (layers, profiles, constituents, lists).
 */
export function extractMaterialsOnDemand(
    store: IfcDataStore,
    entityId: number
): MaterialInfo | null {
    let materialId: number | undefined;

    if (store.onDemandMaterialMap) {
        materialId = store.onDemandMaterialMap.get(entityId);
    } else if (store.relationships) {
        // Fallback: use relationship graph (server-loaded models)
        const related = store.relationships.getRelated(entityId, RelationshipType.AssociatesMaterial, 'inverse');
        if (related.length > 0) materialId = related[0];
    }

    // Check type-level material if occurrence has none
    if (materialId === undefined && store.relationships) {
        const typeIds = store.relationships.getRelated(entityId, RelationshipType.DefinesByType, 'inverse');
        for (const typeId of typeIds) {
            if (store.onDemandMaterialMap) {
                materialId = store.onDemandMaterialMap.get(typeId);
            } else {
                const related = store.relationships.getRelated(typeId, RelationshipType.AssociatesMaterial, 'inverse');
                if (related.length > 0) materialId = related[0];
            }
            if (materialId !== undefined) break;
        }
    }

    if (materialId === undefined) return null;
    if (!store.source?.length) return null;

    const extractor = new EntityExtractor(store.source);
    return resolveMaterial(store, extractor, materialId, new Set());
}

/**
 * Resolve a material entity by ID, handling all IFC material types.
 * Uses visited set to prevent infinite recursion on cyclic *Usage references.
 */
function resolveMaterial(
    store: IfcDataStore,
    extractor: EntityExtractor,
    materialId: number,
    visited: Set<number> = new Set()
): MaterialInfo | null {
    if (visited.has(materialId)) return null;
    visited.add(materialId);

    const ref = store.entityIndex.byId.get(materialId);
    if (!ref) return null;

    const entity = extractor.extractEntity(ref);
    if (!entity) return null;

    const typeUpper = entity.type.toUpperCase();
    const attrs = entity.attributes || [];

    switch (typeUpper) {
        case 'IFCMATERIAL': {
            // IfcMaterial: [Name, Description, Category]
            return {
                type: 'Material',
                name: typeof attrs[0] === 'string' ? attrs[0] : undefined,
                description: typeof attrs[1] === 'string' ? attrs[1] : undefined,
                category: typeof attrs[2] === 'string' ? attrs[2] : undefined,
            };
        }

        case 'IFCMATERIALLAYERSET': {
            // IfcMaterialLayerSet: [MaterialLayers, LayerSetName, Description]
            const layerIds = Array.isArray(attrs[0]) ? attrs[0].filter((id): id is number => typeof id === 'number') : [];
            const layers: MaterialLayerInfo[] = [];

            for (const layerId of layerIds) {
                const layerRef = store.entityIndex.byId.get(layerId);
                if (!layerRef) continue;
                const layerEntity = extractor.extractEntity(layerRef);
                if (!layerEntity) continue;

                const la = layerEntity.attributes || [];
                // IfcMaterialLayer: [Material, LayerThickness, IsVentilated, Name, Description, Category, Priority]
                const matId = typeof la[0] === 'number' ? la[0] : undefined;
                let materialName: string | undefined;
                let materialCategory: string | undefined;
                if (matId) {
                    const matRef = store.entityIndex.byId.get(matId);
                    if (matRef) {
                        const matEntity = extractor.extractEntity(matRef);
                        if (matEntity) {
                            materialName = typeof matEntity.attributes?.[0] === 'string' ? matEntity.attributes[0] : undefined;
                            materialCategory = typeof matEntity.attributes?.[2] === 'string' ? matEntity.attributes[2] : undefined;
                        }
                    }
                }

                layers.push({
                    materialName,
                    thickness: typeof la[1] === 'number' ? la[1] : undefined,
                    isVentilated: la[2] === true || la[2] === '.T.',
                    name: typeof la[3] === 'string' ? la[3] : undefined,
                    category: typeof la[5] === 'string' ? la[5] : undefined,
                    materialCategory,
                });
            }

            return {
                type: 'MaterialLayerSet',
                name: typeof attrs[1] === 'string' ? attrs[1] : undefined,
                description: typeof attrs[2] === 'string' ? attrs[2] : undefined,
                layers,
            };
        }

        case 'IFCMATERIALPROFILESET': {
            // IfcMaterialProfileSet: [Name, Description, MaterialProfiles, CompositeProfile]
            const profileIds = Array.isArray(attrs[2]) ? attrs[2].filter((id): id is number => typeof id === 'number') : [];
            const profiles: MaterialProfileInfo[] = [];

            for (const profId of profileIds) {
                const profRef = store.entityIndex.byId.get(profId);
                if (!profRef) continue;
                const profEntity = extractor.extractEntity(profRef);
                if (!profEntity) continue;

                const pa = profEntity.attributes || [];
                // IfcMaterialProfile: [Name, Description, Material, Profile, Priority, Category]
                const matId = typeof pa[2] === 'number' ? pa[2] : undefined;
                let materialName: string | undefined;
                let materialCategory: string | undefined;
                if (matId) {
                    const matRef = store.entityIndex.byId.get(matId);
                    if (matRef) {
                        const matEntity = extractor.extractEntity(matRef);
                        if (matEntity) {
                            materialName = typeof matEntity.attributes?.[0] === 'string' ? matEntity.attributes[0] : undefined;
                            materialCategory = typeof matEntity.attributes?.[2] === 'string' ? matEntity.attributes[2] : undefined;
                        }
                    }
                }

                profiles.push({
                    materialName,
                    name: typeof pa[0] === 'string' ? pa[0] : undefined,
                    category: typeof pa[5] === 'string' ? pa[5] : undefined,
                    materialCategory,
                });
            }

            return {
                type: 'MaterialProfileSet',
                name: typeof attrs[0] === 'string' ? attrs[0] : undefined,
                description: typeof attrs[1] === 'string' ? attrs[1] : undefined,
                profiles,
            };
        }

        case 'IFCMATERIALCONSTITUENTSET': {
            // IfcMaterialConstituentSet: [Name, Description, MaterialConstituents]
            const constituentIds = Array.isArray(attrs[2]) ? attrs[2].filter((id): id is number => typeof id === 'number') : [];
            const constituents: MaterialConstituentInfo[] = [];

            for (const constId of constituentIds) {
                const constRef = store.entityIndex.byId.get(constId);
                if (!constRef) continue;
                const constEntity = extractor.extractEntity(constRef);
                if (!constEntity) continue;

                const ca = constEntity.attributes || [];
                // IfcMaterialConstituent: [Name, Description, Material, Fraction, Category]
                const matId = typeof ca[2] === 'number' ? ca[2] : undefined;
                let materialName: string | undefined;
                let materialCategory: string | undefined;
                if (matId) {
                    const matRef = store.entityIndex.byId.get(matId);
                    if (matRef) {
                        const matEntity = extractor.extractEntity(matRef);
                        if (matEntity) {
                            materialName = typeof matEntity.attributes?.[0] === 'string' ? matEntity.attributes[0] : undefined;
                            // IfcMaterial: [Name, Description, Category] — IDS material
                            // checks consider both the constituent's own category AND
                            // the underlying IfcMaterial.Category as candidates for
                            // a value match.
                            materialCategory = typeof matEntity.attributes?.[2] === 'string' ? matEntity.attributes[2] : undefined;
                        }
                    }
                }

                constituents.push({
                    materialName,
                    name: typeof ca[0] === 'string' ? ca[0] : undefined,
                    fraction: typeof ca[3] === 'number' ? ca[3] : undefined,
                    category: typeof ca[4] === 'string' ? ca[4] : undefined,
                    materialCategory,
                });
            }

            return {
                type: 'MaterialConstituentSet',
                name: typeof attrs[0] === 'string' ? attrs[0] : undefined,
                description: typeof attrs[1] === 'string' ? attrs[1] : undefined,
                constituents,
            };
        }

        case 'IFCMATERIALLIST': {
            // IfcMaterialList: [Materials]
            const matIds = Array.isArray(attrs[0]) ? attrs[0].filter((id): id is number => typeof id === 'number') : [];
            const materials: string[] = [];

            for (const matId of matIds) {
                const matRef = store.entityIndex.byId.get(matId);
                if (!matRef) continue;
                const matEntity = extractor.extractEntity(matRef);
                if (matEntity) {
                    const name = typeof matEntity.attributes?.[0] === 'string' ? matEntity.attributes[0] : `Material #${matId}`;
                    materials.push(name);
                }
            }

            return {
                type: 'MaterialList',
                materials,
            };
        }

        case 'IFCMATERIALLAYERSETUSAGE': {
            // IfcMaterialLayerSetUsage: [ForLayerSet, LayerSetDirection, DirectionSense, OffsetFromReferenceLine, ...]
            const layerSetId = typeof attrs[0] === 'number' ? attrs[0] : undefined;
            if (layerSetId) {
                return resolveMaterial(store, extractor, layerSetId, visited);
            }
            return null;
        }

        case 'IFCMATERIALPROFILESETUSAGE': {
            // IfcMaterialProfileSetUsage: [ForProfileSet, ...]
            const profileSetId = typeof attrs[0] === 'number' ? attrs[0] : undefined;
            if (profileSetId) {
                return resolveMaterial(store, extractor, profileSetId, visited);
            }
            return null;
        }

        default:
            return null;
    }
}
