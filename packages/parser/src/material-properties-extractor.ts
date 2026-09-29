/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EntityExtractor } from './entity-extractor.js';
import { iterateEffectiveEntities, type EffectiveEntityOverlay } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { getAttributeNames, normalizeIfcTypeName } from './ifc-schema.js';
import { copyParsedExtras, parsePropertyValue, parsePropertyValueWithComplex, type ExtractedProperty } from './property-value-parser.js';
import { resolveAllMaterialDefIds, collectMaterialLeaves, getMaterialDisplay } from './material-resolver.js';
import type { IfcEntity } from './types.js';

export interface MaterialPsetGroup {
    materialId: number;
    materialName: string;
    psets: Array<{ name: string; properties: Array<ExtractedProperty> }>;
}

// ============================================================================
// Material Property Set Extraction (issue #978)
//
// Material psets are attached to an IfcMaterial via IfcMaterialProperties
// (the material's `Material` attribute points back to the material), NOT via
// IfcRelDefinesByProperties — so they never appear in `onDemandPropertyMap`.
// We build a reverse index (materialId -> material psets) by scanning every
// *MaterialProperties entity once, then resolve it for the selected element's
// underlying materials.
// ============================================================================

interface MaterialPsetEntry { name: string; properties: MaterialPsetGroup['psets'][number]['properties'] }

/** Structural overlay shape accepted by live on-demand parser reads. */
export interface MaterialPropertiesView extends EffectiveEntityOverlay {
    getNewEntity?(expressId: number): { readonly type: string; readonly attributes?: readonly unknown[] } | null;
    getPositionalMutationsForEntity?(expressId: number): ReadonlyMap<number, unknown> | null;
    getAttributeMutationsForEntity?(expressId: number): ReadonlyArray<{ name: string; value: string }>;
}

const materialPropertyIndexCache = new WeakMap<IfcDataStore, Map<number, MaterialPsetEntry[]>>();
const materialPropertyOverlayCache = new WeakMap<IfcDataStore, WeakMap<object, { revision: number; index: Map<number, MaterialPsetEntry[]> }>>();

/** Resolve an entity ref from the primary index, falling back to deferred atoms. */
function refFromStore(store: IfcDataStore, id: number) {
    // @raw-entity-enumeration-ok resolve one caller-supplied express id to its source byte span
    return store.entityIndex.byId.get(id) ?? store.deferredEntityIndex?.get(id);
}

/**
 * Resolve the (materialId, propsList, psetName) triple for a *MaterialProperties
 * entity, dispatching on its concrete class rather than guessing attribute
 * positions. The two generic forms that carry an IfcProperty list are handled:
 *   - IfcMaterialProperties      (IFC4+):  [Name, Description, Properties, Material]
 *   - IfcExtendedMaterialProperties (IFC2x3): [Material, ExtendedProperties, Description, Name]
 * The typed IFC2x3 subtypes (IfcMechanicalMaterialProperties, IfcThermalMaterialProperties,
 * …) expose domain-specific scalar fields instead of a generic property list and
 * are not surfaced (returns null) — they are not the Pset_Material* this targets.
 */
function readMaterialPropsEntity(
    typeKey: string,
    attrs: readonly unknown[],
    entityType: string,
): { materialId: number; propsList: unknown[]; psetName: string } | null {
    let materialId: unknown;
    let propsList: unknown;
    let name: unknown;

    if (typeKey === 'IFCMATERIALPROPERTIES') {
        name = attrs[0]; propsList = attrs[2]; materialId = attrs[3];
    } else if (typeKey === 'IFCEXTENDEDMATERIALPROPERTIES') {
        materialId = attrs[0]; propsList = attrs[1]; name = attrs[3];
    } else {
        return null; // typed IFC2x3 scalar subtype — no generic property list
    }

    if (typeof materialId !== 'number' || !Array.isArray(propsList)) return null;
    const psetName = typeof name === 'string' && name ? name : (entityType || 'Material Properties');
    return { materialId, propsList, psetName };
}

/**
 * Build (and memoise) the model-wide map of materialId -> property sets defined
 * via IfcMaterialProperties / IfcExtendedMaterialProperties. These reference the
 * material directly (not through IfcRelDefinesByProperties), so they are found by
 * scanning every *MaterialProperties entity once.
 */
function getMaterialPropertyIndex(store: IfcDataStore, view?: MaterialPropertiesView | null, revision?: number): Map<number, MaterialPsetEntry[]> {
    const overlayCache = view ? materialPropertyOverlayCache.get(store) : undefined;
    const cached = view
        ? revision === undefined ? undefined : overlayCache?.get(view)?.revision === revision
            ? overlayCache.get(view)?.index : undefined
        : materialPropertyIndexCache.get(store);
    if (cached) return cached;

    const index = new Map<number, MaterialPsetEntry[]>();
    // @raw-entity-enumeration-ok source-index presence selects the source-byte path; overlay-created rows are handled by the branch below
    if ((!store.source?.length && !view?.getNewEntities().length) || !store.entityIndex?.byType) {
        if (!view) materialPropertyIndexCache.set(store, index);
        return index;
    }

    const extractor = new EntityExtractor(store.source);
    const wantedTypes = ['IFCMATERIALPROPERTIES', 'IFCEXTENDEDMATERIALPROPERTIES'];
    const sourceIds = new Set<number>();
    for (const type of wantedTypes) {
        // @raw-entity-enumeration-ok collect source candidate ids only; iterateEffectiveEntities below applies the live overlay
        for (const id of store.entityIndex.byType.get(type) ?? []) sourceIds.add(id);
    }
    for (const [id, mutation] of view?.getTypeMutations?.() ?? []) {
        if (wantedTypes.includes(mutation.newType.toUpperCase())) sourceIds.add(id);
    }
    const readEffective = (id: number, type: string): IfcEntity | undefined => {
        const ref = refFromStore(store, id);
        const source = ref ? extractor.extractEntity(ref) : undefined;
        const fresh = !source ? view?.getNewEntity?.(id) : null;
        const base: IfcEntity | undefined = source ?? (fresh ? {
            expressId: id,
            type,
            attributes: [...(fresh.attributes ?? [])] as IfcEntity['attributes'],
        } : undefined);
        if (!base) return undefined;
        const attributes = [...base.attributes];
        for (const [attributeIndex, value] of view?.getPositionalMutationsForEntity?.(id) ?? []) {
            attributes[attributeIndex] = value as IfcEntity['attributes'][number];
        }
        const names = getAttributeNames(type);
        for (const mutation of view?.getAttributeMutationsForEntity?.(id) ?? []) {
            const attributeIndex = names.indexOf(mutation.name);
            if (attributeIndex >= 0) attributes[attributeIndex] = mutation.value;
        }
        // Keep the source STEP spelling for unchanged rows: it is the public
        // fallback pset name when Name is empty. Retyped rows use their new class.
        return { ...base, type: base.type.toUpperCase() === type.toUpperCase()
            ? base.type : normalizeIfcTypeName(type), attributes };
    };

    for (const row of iterateEffectiveEntities(store, view, wantedTypes, sourceIds)) {
            const matPropsId = row.expressId;
            const entity = readEffective(matPropsId, row.type);
            const attrs = entity?.attributes;
            if (!attrs) continue;

            const parsed = readMaterialPropsEntity(row.type, attrs, entity!.type);
            if (!parsed) continue;

            const properties: MaterialPsetEntry['properties'] = [];
            for (const propRef of parsed.propsList) {
                if (typeof propRef !== 'number') continue;
                if (view?.isDeleted(propRef)) continue;
                const propRefEntity = refFromStore(store, propRef);
                const propType = view?.getTypeMutations?.().get(propRef)?.newType
                    ?? propRefEntity?.type
                    ?? view?.getNewEntity?.(propRef)?.type;
                if (!propType) continue;
                const propEntity = readEffective(propRef, propType);
                if (!propEntity) continue;
                const propAttrs = propEntity.attributes || [];
                const propName = typeof propAttrs[0] === 'string' ? propAttrs[0] : '';
                if (!propName) continue;
                const pv = propRefEntity
                    ? parsePropertyValueWithComplex(store, extractor, propEntity)
                    : parsePropertyValue(propEntity);
                const entry: MaterialPsetEntry['properties'][number] = {
                    name: propName,
                    type: pv.type,
                    value: pv.value,
                };
                copyParsedExtras(entry, pv);
                properties.push(entry);
            }
            if (properties.length === 0) continue;

            let list = index.get(parsed.materialId);
            if (!list) { list = []; index.set(parsed.materialId, list); }
            list.push({ name: parsed.psetName, properties });
    }

    if (view && revision !== undefined) {
        let cache = materialPropertyOverlayCache.get(store);
        if (!cache) { cache = new WeakMap(); materialPropertyOverlayCache.set(store, cache); }
        cache.set(view, { revision, index });
    } else if (!view) materialPropertyIndexCache.set(store, index);
    return index;
}

/** Build pset groups for a set of candidate material ids using the reverse index. */
function buildMaterialPsetGroups(store: IfcDataStore, materialIds: number[], view?: MaterialPropertiesView | null, revision?: number): MaterialPsetGroup[] {
    const index = getMaterialPropertyIndex(store, view, revision);
    if (index.size === 0) return [];

    const groups: MaterialPsetGroup[] = [];
    const seen = new Set<number>();
    for (const matId of materialIds) {
        if (seen.has(matId)) continue;
        seen.add(matId);
        const entries = index.get(matId);
        if (!entries || entries.length === 0) continue;
        const { name } = getMaterialDisplay(store, matId);
        groups.push({
            materialId: matId,
            materialName: name,
            psets: entries.map((e) => ({ name: e.name, properties: e.properties })),
        });
    }
    return groups;
}

/**
 * Material property sets associated with a selected element, resolved through
 * its material association. Fans out a layer/profile/constituent set to its
 * member IfcMaterials (where Pset_Material* typically lives) and also checks
 * the set definition itself. Returns one group per material that has psets.
 */
export function extractMaterialPropertiesOnDemand(store: IfcDataStore, entityId: number, view?: MaterialPropertiesView | null, revision?: number): MaterialPsetGroup[] {
    // Every association, not just the primary — psets on a second
    // IfcRelAssociatesMaterial's definition were previously invisible.
    const defIds = resolveAllMaterialDefIds(store, entityId);
    if (defIds.length === 0) return [];
    const ids: number[] = [];
    for (const defId of defIds) {
        ids.push(defId, ...collectMaterialLeaves(store, defId).map((l) => l.id));
    }
    return buildMaterialPsetGroups(store, ids, view, revision);
}

/**
 * Material property sets for a directly-selected material entity (the Materials
 * hierarchy tab). Includes the material's own psets plus, when it is a set
 * definition, those of its member materials.
 */
export function extractMaterialPropertiesForMaterialId(store: IfcDataStore, materialId: number, view?: MaterialPropertiesView | null, revision?: number): MaterialPsetGroup[] {
    const leafIds = collectMaterialLeaves(store, materialId).map((l) => l.id);
    return buildMaterialPsetGroups(store, [materialId, ...leafIds], view, revision);
}
