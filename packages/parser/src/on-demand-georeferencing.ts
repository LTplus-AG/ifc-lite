/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The georeferencing member of the `extract*OnDemand` family. Split out of
 * on-demand-extractors.ts to keep that module under its size ratchet; the
 * behaviour is unchanged and on-demand-extractors.ts re-exports the entry
 * point, so every existing import keeps resolving.
 */

import { EntityExtractor } from './entity-extractor.js';
import type { IfcDataStore } from './columnar-parser.js';
import {
    extractGeoreferencing as extractGeorefFromEntities,
    type GeoreferenceInfo,
} from './georef-extractor.js';
import { oncePerStore } from './on-demand-cache.js';

/**
 * Extract georeferencing info from on-demand store (source buffer + entityIndex).
 * Bridges to the entity-based georef extractor by resolving entities lazily.
 *
 * Memoized per store. On models without an IfcMapConversion (e.g. IFC2x3 files
 * that carry CRS in ePSet_MapConversion / ePSet_ProjectedCRS) the underlying
 * scan decodes EVERY IfcPropertySet from the source buffer to match by name —
 * tens of thousands of decodes on property-heavy models. The viewer calls this
 * on the load/render path (ViewportContainer's Cesium-availability check), which
 * re-runs on every streamed geometry batch, so without caching the cost is
 * O(batches x propertySets) and can turn a multi-second load into minutes.
 * Caching collapses it to a single scan per store. Safe because the result is a
 * pure function of the immutable source + entityIndex; georef *edits* are layered
 * on top later in getEffectiveGeoreference(), not here.
 */
export function extractGeoreferencingOnDemand(store: IfcDataStore): GeoreferenceInfo | null {
    // Don't cache a not-yet-loaded store — it may gain source/entityIndex later.
    if (!store.source?.length || !store.entityIndex) return null;
    return oncePerStore(store, 'georef', () => computeGeoreferencingOnDemand(store));
}

function computeGeoreferencingOnDemand(store: IfcDataStore): GeoreferenceInfo | null {
    if (!store.source?.length || !store.entityIndex) return null;

    const extractor = new EntityExtractor(store.source);
    const { byId, byType } = store.entityIndex;

    // Build a lightweight entity map for just the georef-related types
    const entityMap = new Map<number, { expressId: number; attributes: unknown[] }>();
    const typeMap = new Map<string, number[]>();

    // `byType` is keyed by the RAW STEP type name, so asking for a supertype
    // alone misses every file written with a concrete subtype spelling.
    // IFC4X3's IfcMapConversionScaled is such a subtype: without it a file
    // georeferenced that way produced no mapConversion at all — and therefore
    // no transformMatrix — and was placed at its local origin. Both spellings
    // fold onto the same mixed-case key the georef extractor reads.
    const GEOREF_TYPES: ReadonlyArray<readonly [string, string]> = [
        ['IFCMAPCONVERSION', 'IfcMapConversion'],
        ['IFCMAPCONVERSIONSCALED', 'IfcMapConversion'],
        ['IFCPROJECTEDCRS', 'IfcProjectedCRS'],
        ['IFCSITE', 'IfcSite'],
    ];
    for (const [typeName, displayName] of GEOREF_TYPES) {
        const ids = byType.get(typeName);
        if (!ids?.length) continue;

        const existing = typeMap.get(displayName);
        typeMap.set(displayName, existing ? [...existing, ...ids] : ids);

        for (const id of ids) {
            const ref = byId.get(id);
            if (!ref) continue;
            const entity = extractor.extractEntity(ref);
            if (entity) {
                entityMap.set(id, entity);

                // For IfcProjectedCRS, also resolve the MapUnit reference (attribute [6])
                // so the georef extractor can determine the actual unit scale
                if (typeName === 'IFCPROJECTEDCRS' && entity.attributes) {
                    const mapUnitAttr = entity.attributes[6];
                    const mapUnitRefId = typeof mapUnitAttr === 'number' ? mapUnitAttr : null;
                    if (mapUnitRefId && !entityMap.has(mapUnitRefId)) {
                        const unitRef = byId.get(mapUnitRefId);
                        if (unitRef) {
                            const unitEntity = extractor.extractEntity(unitRef);
                            if (unitEntity) entityMap.set(mapUnitRefId, unitEntity);
                        }
                    }
                }
            }
        }
    }

    // IFC2x3 fallback: models without IfcMapConversion store georeferencing in
    // ePSet_MapConversion / ePSet_ProjectedCRS property sets. Those aren't
    // loaded above, so the ePSet path in extractGeorefFromEntities had nothing
    // to read and the model fell back to the legacy IfcSite EPSG:4326 (wrong
    // CRS). Only scan property sets when no IfcMapConversion exists, and only
    // pull in the georef ePSets + their values — not every pset in the model.
    if (!typeMap.has('IfcMapConversion')) {
        const psetIds = byType.get('IFCPROPERTYSET');
        if (psetIds?.length) {
            const georefPsetIds: number[] = [];
            const childIds = new Set<number>();
            for (const id of psetIds) {
                const ref = byId.get(id);
                if (!ref) continue;
                const entity = extractor.extractEntity(ref);
                if (!entity?.attributes) continue;
                // IfcPropertySet: Name (2), HasProperties (4)
                const name = typeof entity.attributes[2] === 'string'
                    ? (entity.attributes[2] as string).toLowerCase()
                    : '';
                if (name !== 'epset_mapconversion' && name !== 'epset_projectedcrs') continue;
                entityMap.set(id, entity);
                georefPsetIds.push(id);
                const props = entity.attributes[4];
                if (Array.isArray(props)) {
                    for (const propRef of props) {
                        const propId = typeof propRef === 'number' ? propRef : null;
                        if (propId === null || childIds.has(propId)) continue;
                        // Property atoms may be deferred on huge files (not in
                        // the primary byId index) — fall back like refFromStore.
                        const childRef = byId.get(propId) ?? store.deferredEntityIndex?.get(propId);
                        if (!childRef) continue;
                        const child = extractor.extractEntity(childRef);
                        if (child) {
                            entityMap.set(propId, child);
                            childIds.add(propId);
                        }
                    }
                }
            }
            if (georefPsetIds.length) {
                typeMap.set('IfcPropertySet', georefPsetIds);
            }
        }
    }

    if (entityMap.size === 0) return null;

    // Cast to IfcEntity (they share the same shape)
    return extractGeorefFromEntities(entityMap as Parameters<typeof extractGeorefFromEntities>[0], typeMap);
}
