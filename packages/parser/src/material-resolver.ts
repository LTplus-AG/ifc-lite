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
import { isIfcTypeLikeEntity } from './columnar-parser-indexes.js';

export interface MaterialInfo {
    type: 'Material' | 'MaterialLayerSet' | 'MaterialProfileSet' | 'MaterialConstituentSet' | 'MaterialList';
    name?: string;
    description?: string;
    /** IfcMaterial.Category (IFC4+). */
    category?: string;
    layers?: MaterialLayerInfo[];
    profiles?: MaterialProfileInfo[];
    constituents?: MaterialConstituentInfo[];
    /**
     * Members of an IfcMaterialList. Each entry surfaces the material's
     * Name plus optional Category — IDS material checks match against
     * either, so callers must propagate both.
     */
    materials?: Array<{ name: string; category?: string }>;
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

    // The map value is a list of associations (multiple IfcRelAssociatesMaterial
    // on one element are valid in the wild); this single-material API resolves
    // the primary (first) one. buildMaterialUsageIndex is where all associations
    // are honoured.
    if (store.onDemandMaterialMap) {
        materialId = store.onDemandMaterialMap.get(entityId)?.[0];
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
                materialId = store.onDemandMaterialMap.get(typeId)?.[0];
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

                // Convert raw IFC value to metres so downstream UI doesn't
                // have to guess. Files with LENGTHUNIT=MILLI (e.g. Dutch
                // Revit / ArchiCAD exports — schependomlaan.ifc) store
                // 60 for a 60 mm prefab slab; without this scale the
                // properties panel rendered "60.0 m" because
                // `formatThickness` assumes its input is metres.
                const rawThickness = typeof la[1] === 'number' ? la[1] : undefined;
                const scale = store.lengthUnitScale ?? 1;
                const thickness = rawThickness !== undefined ? rawThickness * scale : undefined;
                layers.push({
                    materialName,
                    thickness,
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
            const materials: Array<{ name: string; category?: string }> = [];

            for (const matId of matIds) {
                const matRef = store.entityIndex.byId.get(matId);
                if (!matRef) continue;
                const matEntity = extractor.extractEntity(matRef);
                if (matEntity) {
                    const name = typeof matEntity.attributes?.[0] === 'string' ? matEntity.attributes[0] : `Material #${matId}`;
                    const category = typeof matEntity.attributes?.[2] === 'string' ? matEntity.attributes[2] : undefined;
                    materials.push({ name, ...(category ? { category } : {}) });
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

// ============================================================================
// Material → element usage, leaf-material resolution, and display helpers.
//
// Powers the viewer's "Materials" hierarchy tab and the per-material totals
// panel (issue #978). These resolve the *base* IfcMaterial(s) reachable from
// an element's association (a layer/profile/constituent set fans out to its
// member materials) plus a volume *weight* per base material so the panel can
// apportion an element's quantity across the materials it is built from.
// ============================================================================

/** A base IfcMaterial reachable from an element's material association. */
export interface MaterialLeaf {
    /** Express id of the underlying IfcMaterial (or the definition itself when
     *  no nested IfcMaterial could be resolved). */
    id: number;
    name?: string;
    category?: string;
    /** Share of the element's volume attributable to this material, in [0,1].
     *  Leaves of one element sum to ~1 (layer thickness / constituent fraction;
     *  equal split when no proportion data is available). */
    weight: number;
}

/** Aggregated usage of one base material across the model. */
export interface MaterialUsage {
    /** Express id of the base IfcMaterial. */
    id: number;
    name: string;
    category?: string;
    /** IFC class of the material entity (e.g. "IfcMaterial"). */
    ifcClass: string;
    /** Every element using this material, with its volume weight. */
    entries: Array<{ entityId: number; weight: number }>;
}

/** Resolve an entity ref from the primary index, falling back to deferred atoms. */
function getRef(store: IfcDataStore, id: number) {
    return store.entityIndex.byId.get(id) ?? store.deferredEntityIndex?.get(id);
}

/** Read an IfcMaterial's Name (attr 0) and Category (attr 2). */
function readMaterialNameCategory(
    store: IfcDataStore,
    extractor: EntityExtractor,
    materialId: number,
): { name?: string; category?: string } {
    const ref = getRef(store, materialId);
    if (!ref) return {};
    const entity = extractor.extractEntity(ref);
    const attrs = entity?.attributes ?? [];
    return {
        name: typeof attrs[0] === 'string' ? attrs[0] : undefined,
        category: typeof attrs[2] === 'string' ? attrs[2] : undefined,
    };
}

/**
 * Resolve the material *definition* directly associated with an element
 * (IfcMaterial / IfcMaterial*Set / *Usage). Mirrors the lookup at the top of
 * {@link extractMaterialsOnDemand}: occurrence association first, then the
 * element's type. Returns the definition express id, or undefined.
 */
export function resolveMaterialDefId(store: IfcDataStore, entityId: number): number | undefined {
    let materialId: number | undefined;

    if (store.onDemandMaterialMap) {
        materialId = store.onDemandMaterialMap.get(entityId)?.[0];
    } else if (store.relationships) {
        const related = store.relationships.getRelated(entityId, RelationshipType.AssociatesMaterial, 'inverse');
        if (related.length > 0) materialId = related[0];
    }

    if (materialId === undefined && store.relationships) {
        const typeIds = store.relationships.getRelated(entityId, RelationshipType.DefinesByType, 'inverse');
        for (const typeId of typeIds) {
            if (store.onDemandMaterialMap) {
                materialId = store.onDemandMaterialMap.get(typeId)?.[0];
            } else {
                const related = store.relationships.getRelated(typeId, RelationshipType.AssociatesMaterial, 'inverse');
                if (related.length > 0) materialId = related[0];
            }
            if (materialId !== undefined) break;
        }
    }

    return materialId;
}

const leavesCache = new WeakMap<IfcDataStore, Map<number, MaterialLeaf[]>>();

/**
 * Resolve the base IfcMaterial(s) for a material definition, with a volume
 * weight per material. Layer sets split by layer thickness, constituent sets by
 * fraction, profile/list sets equally; a plain IfcMaterial yields a single
 * leaf with weight 1. Results are memoised per (store, defId) — a type-shared
 * layer set is resolved once for the whole model.
 */
export function collectMaterialLeaves(store: IfcDataStore, defId: number): MaterialLeaf[] {
    let cache = leavesCache.get(store);
    if (!cache) { cache = new Map(); leavesCache.set(store, cache); }
    const cached = cache.get(defId);
    if (cached) return cached;

    const extractor = store.source?.length ? new EntityExtractor(store.source) : null;
    let result: MaterialLeaf[];
    if (extractor) {
        result = resolveLeaves(store, extractor, defId, new Set());
    } else {
        // Source-less store (server-loaded models keep `source` as an EMPTY
        // Uint8Array): a definition's internal structure (layers/profiles/
        // constituents -> base materials) lives in attribute references that
        // the server does not emit as relationship rows, so it cannot be
        // fanned out here. Surface the definition itself as one opaque leaf
        // carrying the element's full weight - the usage index then still
        // groups elements by their material association instead of staying
        // empty. Dangling definition refs resolve to nothing, mirroring
        // resolveLeaves.
        const ref = getRef(store, defId);
        result = ref
            ? [{ id: defId, name: store.entities?.getName(defId) || undefined, weight: 1 }]
            : [];
    }
    cache.set(defId, result);
    return result;
}

/** Accumulate a leaf into the map, summing weights when the material repeats. */
function mergeLeaves(into: Map<number, MaterialLeaf>, leaf: MaterialLeaf): void {
    const existing = into.get(leaf.id);
    if (existing) {
        existing.weight += leaf.weight;
        if (!existing.name && leaf.name) existing.name = leaf.name;
        if (!existing.category && leaf.category) existing.category = leaf.category;
    } else {
        into.set(leaf.id, { ...leaf });
    }
}

/** Recursively resolve a material definition into weighted base-material leaves
 *  (cycle-guarded via `visited`). See {@link collectMaterialLeaves}. */
function resolveLeaves(
    store: IfcDataStore,
    extractor: EntityExtractor,
    defId: number,
    visited: Set<number>,
): MaterialLeaf[] {
    if (visited.has(defId)) return [];
    visited.add(defId);

    const ref = getRef(store, defId);
    if (!ref) return [];
    const entity = extractor.extractEntity(ref);
    if (!entity) return [];

    const typeUpper = entity.type.toUpperCase();
    const attrs = entity.attributes || [];
    const merged = new Map<number, MaterialLeaf>();

    const addMaterialLeaf = (matId: number | undefined, weight: number) => {
        if (matId === undefined) return;
        const { name, category } = readMaterialNameCategory(store, extractor, matId);
        mergeLeaves(merged, { id: matId, name, category, weight });
    };

    switch (typeUpper) {
        case 'IFCMATERIAL':
            return [{
                id: defId,
                name: typeof attrs[0] === 'string' ? attrs[0] : undefined,
                category: typeof attrs[2] === 'string' ? attrs[2] : undefined,
                weight: 1,
            }];

        case 'IFCMATERIALLAYERSET': {
            // IfcMaterialLayerSet: [MaterialLayers, LayerSetName, Description]
            const layerIds = Array.isArray(attrs[0]) ? attrs[0].filter((id): id is number => typeof id === 'number') : [];
            const layers: Array<{ matId?: number; thickness: number }> = [];
            for (const layerId of layerIds) {
                const layerRef = getRef(store, layerId);
                if (!layerRef) continue;
                const la = extractor.extractEntity(layerRef)?.attributes ?? [];
                // IfcMaterialLayer: [Material, LayerThickness, IsVentilated, Name, Description, Category, Priority]
                layers.push({
                    matId: typeof la[0] === 'number' ? la[0] : undefined,
                    // Non-finite thickness would turn every weight into NaN
                    // (Infinity/Infinity) - treat it as absent like <= 0.
                    thickness: typeof la[1] === 'number' && Number.isFinite(la[1]) && la[1] > 0 ? la[1] : 0,
                });
            }
            const totalThickness = layers.reduce((s, l) => s + l.thickness, 0);
            for (const layer of layers) {
                const weight = totalThickness > 0
                    ? layer.thickness / totalThickness
                    : (layers.length > 0 ? 1 / layers.length : 0);
                addMaterialLeaf(layer.matId, weight);
            }
            return [...merged.values()];
        }

        case 'IFCMATERIALPROFILESET': {
            // IfcMaterialProfileSet: [Name, Description, MaterialProfiles, CompositeProfile]
            const profileIds = Array.isArray(attrs[2]) ? attrs[2].filter((id): id is number => typeof id === 'number') : [];
            const n = profileIds.length;
            for (const profId of profileIds) {
                const profRef = getRef(store, profId);
                if (!profRef) continue;
                const pa = extractor.extractEntity(profRef)?.attributes ?? [];
                // IfcMaterialProfile: [Name, Description, Material, Profile, Priority, Category]
                addMaterialLeaf(typeof pa[2] === 'number' ? pa[2] : undefined, n > 0 ? 1 / n : 0);
            }
            return [...merged.values()];
        }

        case 'IFCMATERIALCONSTITUENTSET': {
            // IfcMaterialConstituentSet: [Name, Description, MaterialConstituents]
            const constIds = Array.isArray(attrs[2]) ? attrs[2].filter((id): id is number => typeof id === 'number') : [];
            const constituents: Array<{ matId?: number; fraction?: number }> = [];
            for (const constId of constIds) {
                const constRef = getRef(store, constId);
                if (!constRef) continue;
                const ca = extractor.extractEntity(constRef)?.attributes ?? [];
                // IfcMaterialConstituent: [Name, Description, Material, Fraction, Category]
                constituents.push({
                    matId: typeof ca[2] === 'number' ? ca[2] : undefined,
                    // Non-finite (NaN/Infinity), zero, and negative fractions are
                    // all malformed for an IfcNormalisedRatioMeasure - treat them
                    // as unset so they can't poison the weight arithmetic below.
                    fraction: typeof ca[3] === 'number' && Number.isFinite(ca[3]) && ca[3] > 0 ? ca[3] : undefined,
                });
            }
            // Constituent Fraction is optional per-constituent. When SOME
            // constituents carry a fraction and others don't, the un-fractioned
            // siblings must not collapse to weight 0 (the old `(f ?? 0)/total`
            // did exactly that, dropping them from the totals). Instead the
            // constituents WITHOUT an explicit fraction share whatever remains
            // of the whole (1 - sum of explicit) evenly; when every constituent
            // carries a fraction we normalise by their sum; with none we split
            // equally. In every branch the weights sum to exactly 1, so the
            // totals panel can never over-report an element's quantities.
            const explicitTotal = constituents.reduce((s, c) => s + (c.fraction ?? 0), 0);
            const implicitCount = constituents.reduce((n, c) => n + (c.fraction === undefined ? 1 : 0), 0);
            if (explicitTotal <= 0) {
                const n = constituents.length;
                for (const c of constituents) addMaterialLeaf(c.matId, n > 0 ? 1 / n : 0);
            } else if (implicitCount === 0) {
                for (const c of constituents) addMaterialLeaf(c.matId, (c.fraction ?? 0) / explicitTotal);
            } else {
                // Mixed: implicit siblings share the remainder of the whole.
                // When the explicit fractions already fill (or overflow) the
                // whole, give each implicit sibling an even 1/n share instead
                // so it still registers - then renormalise the set to sum to 1
                // (e.g. {1.0, unset} would otherwise weigh 1.5x the element).
                const remaining = 1 - explicitTotal;
                const perImplicit = remaining > 0 ? remaining / implicitCount : 1 / constituents.length;
                const total = explicitTotal + perImplicit * implicitCount;
                for (const c of constituents) addMaterialLeaf(c.matId, (c.fraction ?? perImplicit) / total);
            }
            return [...merged.values()];
        }

        case 'IFCMATERIALLIST': {
            // IfcMaterialList: [Materials]
            const matIds = Array.isArray(attrs[0]) ? attrs[0].filter((id): id is number => typeof id === 'number') : [];
            const n = matIds.length;
            for (const matId of matIds) addMaterialLeaf(matId, n > 0 ? 1 / n : 0);
            return [...merged.values()];
        }

        case 'IFCMATERIALLAYERSETUSAGE': {
            const layerSetId = typeof attrs[0] === 'number' ? attrs[0] : undefined;
            return layerSetId ? resolveLeaves(store, extractor, layerSetId, visited) : [];
        }

        case 'IFCMATERIALPROFILESETUSAGE': {
            const profileSetId = typeof attrs[0] === 'number' ? attrs[0] : undefined;
            return profileSetId ? resolveLeaves(store, extractor, profileSetId, visited) : [];
        }

        default:
            // Unknown definition — treat as a single opaque material so it still
            // appears in the tab and carries the element's full volume.
            return [{
                id: defId,
                name: typeof attrs[0] === 'string' ? attrs[0] : undefined,
                weight: 1,
            }];
    }
}

const usageIndexCache = new WeakMap<IfcDataStore, Map<number, MaterialUsage>>();

/**
 * Build (and memoise) the model-wide index of base material → using elements,
 * with per-element volume weights. Derived from the forward
 * `onDemandMaterialMap` (element → definition) that the parser already builds
 * when present, falling back to the relationship graph's AssociatesMaterial
 * edges (server-loaded models). Keyed by base IfcMaterial express id.
 */
export function buildMaterialUsageIndex(store: IfcDataStore): Map<number, MaterialUsage> {
    const cached = usageIndexCache.get(store);
    if (cached) return cached;

    const usage = new Map<number, MaterialUsage>();

    // Element -> material-definition list. Prefer the parser's forward
    // `onDemandMaterialMap`; when it's absent (server-loaded models) fall back
    // to the relationship graph's AssociatesMaterial edges - the same fallback
    // extractMaterialsOnDemand uses - so the model-wide index still populates
    // instead of silently caching an empty map forever. Candidates are
    // enumerated via entityIndex.byId (every server entity is indexed there):
    // the server's facade graph exposes only getRelated/getEdges closures over
    // private maps and keeps `inverse.offsets` as an EMPTY Map, so iterating
    // the CSR columns is not an option for the exact store this fallback
    // serves.
    let forward = store.onDemandMaterialMap;
    if (!forward && store.relationships) {
        const rebuilt = new Map<number, number[]>();
        for (const entityId of store.entityIndex.byId.keys()) {
            const defs = store.relationships.getRelated(entityId, RelationshipType.AssociatesMaterial, 'inverse');
            if (defs.length > 0) rebuilt.set(entityId, defs);
        }
        forward = rebuilt;
    }

    // No source requirement: server-loaded stores carry an EMPTY source buffer,
    // and collectMaterialLeaves has a source-less path (the definition becomes
    // one opaque full-weight leaf) precisely so this index works for them.
    if (forward && forward.size > 0) {
        // Guards against a malformed model double-typing one occurrence
        // (two IfcRelDefinesByType rels → duplicate forward edges), which
        // would otherwise double-count it in the totals panel.
        const seenPerMaterial = new Map<number, Set<number>>();
        for (const [entityId, defIds] of forward) {
            // IfcRelAssociatesMaterial commonly targets the TYPE entity
            // (IfcDoorType etc.). The tab/totals need occurrences — a type
            // has no geometry, so a type-keyed entry is invisible in the
            // By Material tree (geom filter) and mis-attributes quantities
            // (#1755). Expand type keys to their instances via forward
            // DefinesByType edges; occurrences with their OWN association
            // are skipped (IFC precedence: occurrence overrides type — they
            // get their entry from their own map iteration). The type keeps
            // no entry of its own: a zero-instance type would only produce
            // dead rows. Stores without a relationship graph (minimal test
            // stores) keep the old verbatim behavior.
            const ref = getRef(store, entityId);
            let targets: readonly number[];
            if (ref && store.relationships && isIfcTypeLikeEntity(ref.type.toUpperCase())) {
                targets = store.relationships
                    .getRelated(entityId, RelationshipType.DefinesByType, 'forward')
                    .filter((occId) => !forward!.has(occId));
            } else {
                targets = [entityId];
            }
            if (targets.length === 0) continue;

            // An element can carry more than one material association (valid in
            // the wild); every definition contributes its leaves.
            for (const defId of defIds) {
                const leaves = collectMaterialLeaves(store, defId);
                for (const leaf of leaves) {
                    let entry = usage.get(leaf.id);
                    if (!entry) {
                        const ref = getRef(store, leaf.id);
                        entry = {
                            id: leaf.id,
                            name: leaf.name || `Material #${leaf.id}`,
                            category: leaf.category,
                            ifcClass: ref?.type || 'IfcMaterial',
                            entries: [],
                        };
                        usage.set(leaf.id, entry);
                    }
                    let seen = seenPerMaterial.get(leaf.id);
                    if (!seen) { seen = new Set(); seenPerMaterial.set(leaf.id, seen); }
                    for (const target of targets) {
                        if (seen.has(target)) continue;
                        seen.add(target);
                        entry.entries.push({ entityId: target, weight: leaf.weight });
                    }
                }
            }
        }
    }

    // Don't memoise an empty index built from a store that had NO material
    // inputs at all (no forward map, no relationship graph, no source): such a
    // store may be populated later (a load that wires onDemandMaterialMap /
    // relationships after first render), and a cached empty result would mask
    // it forever. Non-empty results, or empty ones from a store that did have
    // inputs (a genuinely material-free model), are safe to cache.
    const hadInputs = (store.onDemandMaterialMap?.size ?? 0) > 0
        || !!store.relationships
        || !!store.source?.length;
    if (usage.size > 0 || hadInputs) {
        usageIndexCache.set(store, usage);
    }
    return usage;
}

const displayCache = new WeakMap<IfcDataStore, Map<number, { name: string; type: string }>>();

/** Resolve a material entity's display name + IFC class for headers/labels.
 *  Memoised per (store, materialId) — callers resolve many materials in a loop. */
export function getMaterialDisplay(store: IfcDataStore, materialId: number): { name: string; type: string } {
    let cache = displayCache.get(store);
    if (!cache) { cache = new Map(); displayCache.set(store, cache); }
    const hit = cache.get(materialId);
    if (hit) return hit;

    const ref = getRef(store, materialId);
    const type = ref?.type || 'IfcMaterial';
    let result: { name: string; type: string };
    if (!ref || !store.source?.length) {
        result = { name: `Material #${materialId}`, type };
    } else {
        const extractor = new EntityExtractor(store.source);
        const attrs = extractor.extractEntity(ref)?.attributes ?? [];
        const name = typeof attrs[0] === 'string' && attrs[0] ? attrs[0] : `Material #${materialId}`;
        result = { name, type };
    }
    cache.set(materialId, result);
    return result;
}
