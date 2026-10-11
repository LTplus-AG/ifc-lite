/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The existing native material shape decoder, fed by canonical effective records (#7119). */
import { getBoolean, getNumber, getReference, getReferences } from './attribute-helpers.js';
import { resolveEntityLengthUnitScale } from './unit-extractor.js';
import type { IfcDataStore } from './columnar-parser.js';
import type { MaterialRecordReader } from './material-overlay.js';
import type { MaterialInfo, MaterialLayerInfo, MaterialProfileInfo, MaterialConstituentInfo } from './material-resolver.js';

/**
 * Resolve a material entity by ID, handling all IFC material types. `visited`
 * guards cyclic *Usage references; `originEntityId` (the calling element/type)
 * lets a layer's thickness resolve its own project's unit scale below.
 */
export function resolveMaterial(
    store: IfcDataStore,
    read: MaterialRecordReader,
    materialId: number,
    visited: Set<number> = new Set(), originEntityId?: number
): MaterialInfo | null {
    while (true) {
    if (visited.has(materialId)) return null;
    visited.add(materialId);

    const entity = read(materialId);
    if (!entity) return null;

    const typeUpper = entity.type.toUpperCase();
    const attrs = entity.attributes || [];
    let unresolved = false;

    if (typeUpper === 'IFCMATERIALLAYERSETUSAGE' || typeUpper === 'IFCMATERIALPROFILESETUSAGE') {
        const next = getReference(attrs[0]);
        if (next === undefined) return null;
        materialId = next; continue;
    }
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
            const layerIds = getReferences(attrs[0]) ?? [];
            const layers: MaterialLayerInfo[] = [];

            for (const layerId of layerIds) {
                // @raw-entity-enumeration-ok decode this material set's referenced layer record
                const layerRef = read(layerId);
                if (!layerRef || layerRef.type.toUpperCase() !== 'IFCMATERIALLAYER') { unresolved = true; continue; }
                const layerEntity = layerRef;
                if (!layerEntity) continue;

                const la = layerEntity.attributes || [];
                // IfcMaterialLayer: [Material, LayerThickness, IsVentilated, Name, Description, Category, Priority]
                const matId = getReference(la[0]);
                let materialName: string | undefined;
                let materialCategory: string | undefined;
                if (matId && read(matId)?.type.toUpperCase() !== 'IFCMATERIAL') unresolved = true;
                if (matId) {
                    // @raw-entity-enumeration-ok decode the layer's referenced material record
                    const matRef = read(matId);
                    if (matRef?.type.toUpperCase() === 'IFCMATERIAL') {
                        const matEntity = matRef;
                        if (matEntity) {
                            materialName = typeof matEntity.attributes?.[0] === 'string' ? matEntity.attributes[0] : undefined;
                            materialCategory = typeof matEntity.attributes?.[2] === 'string' ? matEntity.attributes[2] : undefined;
                        }
                    }
                }

                // Convert raw IFC value to metres (a 60 mm slab must not read
                // "60.0 m"). `store.lengthUnitScale` answers for the file's
                // FIRST IfcProject only, wrong for a MergedExporter federated
                // layer in a LATER project — resolve per `originEntityId`.
                const rawThickness = getNumber(la[1]);
                const scale = originEntityId !== undefined ? resolveEntityLengthUnitScale(store.source, store.entityIndex, store.relationships, originEntityId) : (store.lengthUnitScale ?? 1);
                const thickness = rawThickness !== undefined ? rawThickness * scale : undefined;
                layers.push({
                    materialName,
                    thickness,
                    isVentilated: getBoolean(la[2]),
                    name: typeof la[3] === 'string' ? la[3] : undefined,
                    category: typeof la[5] === 'string' ? la[5] : undefined,
                    materialCategory,
                });
            }

            return {
                type: 'MaterialLayerSet',
                name: typeof attrs[1] === 'string' ? attrs[1] : undefined,
                description: typeof attrs[2] === 'string' ? attrs[2] : undefined,
                layers, ...(unresolved ? { unresolved: true } : {}),
            };
        }

        case 'IFCMATERIALPROFILESET': {
            // IfcMaterialProfileSet: [Name, Description, MaterialProfiles, CompositeProfile]
            const profileIds = getReferences(attrs[2]) ?? [];
            const profiles: MaterialProfileInfo[] = [];

            for (const profId of profileIds) {
                // @raw-entity-enumeration-ok decode this profile set's referenced profile record
                const profRef = read(profId);
                if (!profRef || profRef.type.toUpperCase() !== 'IFCMATERIALPROFILE') { unresolved = true; continue; }
                const profEntity = profRef;
                if (!profEntity) continue;

                const pa = profEntity.attributes || [];
                // IfcMaterialProfile: [Name, Description, Material, Profile, Priority, Category]
                const matId = getReference(pa[2]);
                let materialName: string | undefined;
                let materialCategory: string | undefined;
                if (matId && read(matId)?.type.toUpperCase() !== 'IFCMATERIAL') unresolved = true;
                if (matId) {
                    // @raw-entity-enumeration-ok decode the profile's referenced material record
                    const matRef = read(matId);
                    if (matRef?.type.toUpperCase() === 'IFCMATERIAL') {
                        const matEntity = matRef;
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
                profiles, ...(unresolved ? { unresolved: true } : {}),
            };
        }

        case 'IFCMATERIALCONSTITUENTSET': {
            // IfcMaterialConstituentSet: [Name, Description, MaterialConstituents]
            const constituentIds = getReferences(attrs[2]) ?? [];
            const constituents: MaterialConstituentInfo[] = [];

            for (const constId of constituentIds) {
                // @raw-entity-enumeration-ok decode this constituent set's referenced constituent record
                const constRef = read(constId);
                if (!constRef || constRef.type.toUpperCase() !== 'IFCMATERIALCONSTITUENT') { unresolved = true; continue; }
                const constEntity = constRef;
                if (!constEntity) continue;

                const ca = constEntity.attributes || [];
                // IfcMaterialConstituent: [Name, Description, Material, Fraction, Category]
                const matId = getReference(ca[2]);
                let materialName: string | undefined;
                let materialCategory: string | undefined;
                if (matId && read(matId)?.type.toUpperCase() !== 'IFCMATERIAL') unresolved = true;
                if (matId) {
                    // @raw-entity-enumeration-ok decode the constituent's referenced material record
                    const matRef = read(matId);
                    if (matRef?.type.toUpperCase() === 'IFCMATERIAL') {
                        const matEntity = matRef;
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
                    fraction: getNumber(ca[3]),
                    category: typeof ca[4] === 'string' ? ca[4] : undefined,
                    materialCategory,
                });
            }

            return {
                type: 'MaterialConstituentSet',
                name: typeof attrs[0] === 'string' ? attrs[0] : undefined,
                description: typeof attrs[1] === 'string' ? attrs[1] : undefined,
                constituents, ...(unresolved ? { unresolved: true } : {}),
            };
        }

        case 'IFCMATERIALLIST': {
            // IfcMaterialList: [Materials]
            const matIds = getReferences(attrs[0]) ?? [];
            const materials: Array<{ name: string; category?: string }> = [];

            for (const matId of matIds) {
                // @raw-entity-enumeration-ok decode this material list's referenced material record
                const matRef = read(matId);
                if (!matRef || matRef.type.toUpperCase() !== 'IFCMATERIAL') { unresolved = true; continue; }
                const matEntity = matRef;
                if (matEntity) {
                    // STEP null is a fully read unset Name, not missing material data (#7211).
                    if (matEntity.attributes?.[0] !== null && typeof matEntity.attributes?.[0] !== 'string') unresolved = true;
                    const name = typeof matEntity.attributes?.[0] === 'string'
                        ? matEntity.attributes[0] : `Material #${matId}`;
                    const category = typeof matEntity.attributes?.[2] === 'string' ? matEntity.attributes[2] : undefined;
                    materials.push({ name, ...(category ? { category } : {}) });
                }
            }

            return {
                type: 'MaterialList',
                materials, ...(unresolved ? { unresolved: true } : {}),
            };
        }

        default:
            return null;
    }
    }
}

