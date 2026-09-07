/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Root-attribute resolution for on-demand entity extraction.
 * Extracted from columnar-parser.ts to keep that module under its size budget.
 *
 * Resolves the common IfcRoot-family display attributes (GlobalId, Name,
 * Description, ObjectType, Tag, LongName) from a raw entity's attribute
 * array by schema-derived attribute name, plus the on-demand "all named
 * attributes" extraction used by the query layer's IDS/property coercion.
 */

import { EntityExtractor } from './entity-extractor.js';
import { getAttributeNames, getAttributeNamesAcrossSchemas } from './ifc-schema.js';
import { SKIP_DISPLAY_ATTRS } from './columnar-parser-indexes.js';
import type { EntityRef } from './types.js';
import type { IfcEntity, IfcAttributeValue } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';

export function getEntityRefFromStore(store: IfcDataStore, expressId: number): EntityRef | undefined {
    return store.entityIndex.byId.get(expressId) ?? store.deferredEntityIndex?.get(expressId);
}

/**
 * Extract entity attributes on-demand from source buffer.
 * Returns globalId, name, description, objectType, tag mapped by schema name
 * (see {@link extractRootAttributesFromEntity}), so the result stays correct
 * for entity types whose attribute order differs from the IfcElement layout.
 * This is used for entities that weren't fully parsed during initial load.
 */
export function extractEntityAttributesOnDemand(
    store: IfcDataStore,
    entityId: number
): { globalId: string; name: string; description: string; objectType: string; tag: string } {
    const ref = store.entityIndex.byId.get(entityId);
    if (!ref) {
        return { globalId: '', name: '', description: '', objectType: '', tag: '' };
    }

    const extractor = new EntityExtractor(store.source);
    const entity = extractor.extractEntity(ref);
    if (!entity) {
        return { globalId: '', name: '', description: '', objectType: '', tag: '' };
    }

    return extractRootAttributesFromEntity(entity);
}

/**
 * Extract ALL named entity attributes on-demand from source buffer.
 * Uses the IFC schema to map attribute indices to names.
 * Returns only string/enum attributes, skipping references and structural attributes.
 */
export function extractAllEntityAttributes(
    store: IfcDataStore,
    entityId: number
): Array<{ name: string; value: string | number | boolean }> {
    const ref = store.entityIndex.byId.get(entityId);
    if (!ref) return [];

    const extractor = new EntityExtractor(store.source);
    const entity = extractor.extractEntity(ref);
    if (!entity) return [];

    const attrs = entity.attributes || [];
    // Use properly-cased type name from entity table (IfcTypeEnumToString)
    // instead of ref.type which is UPPERCASE from STEP (e.g., IFCWALLSTANDARDCASE)
    // and breaks multi-word type normalization in getAttributeNames.
    // For resource-level entities (IfcTask, IfcTaskTime, IfcMaterial,
    // IfcClassification, ...) the entity table returns 'Unknown';
    // fall back to ref.type so the schema-driven attribute-name
    // resolution still works for those types.
    const tableName = store.entities.getTypeName(entityId);
    const typeName = tableName && tableName !== 'Unknown' ? tableName : ref.type;
    // Named across the bundled schema union (2X3 + 4 + 4X3), not through the
    // IFC4 codegen pin alone. The pin answers an EMPTY list — not a wrong one —
    // for every class it does not carry, and 251 real classes are outside it:
    // the IFC2X3 ones IFC4 dropped and the whole IFC4X3 infrastructure
    // vocabulary (`IfcCourse`, `IfcPavement`, `IfcKerb`, `IfcSignal`, `IfcRoad`,
    // …). An empty list means this function returns NO attributes for such an
    // entity, so every caller that looks one up by name silently finds nothing
    // and cannot tell that apart from an unset slot. The model-diff adapters
    // read `PredefinedType` this way, which made a cleared `PredefinedType` —
    // the single most common edit in a real infrastructure revision — compare
    // equal to itself on exactly the classes IFC4X3 exists for. Same pinned-
    // registry family as #2001/#2003/#2021.
    //
    // Provably additive: `getAttributeNamesAcrossSchemas` returns the pinned
    // result unchanged whenever the pin has one, so no IFC2X3 or IFC4 entity's
    // attribute list — or the hash anyone derives from it — moves.
    const attrNames = getAttributeNamesAcrossSchemas(typeName);

    const result: Array<{ name: string; value: string | number | boolean }> = [];
    const len = Math.min(attrs.length, attrNames.length);
    for (let i = 0; i < len; i++) {
        const attrName = attrNames[i];
        if (SKIP_DISPLAY_ATTRS.has(attrName)) continue;

        const raw = attrs[i];
        // STEP `$` (unset) and `*` (derived) deserialize as null /
        // undefined and must be skipped. Strings are emitted with
        // `.ENUM.` markers stripped. Empty strings are preserved so
        // IDS optional-attribute checks can distinguish "slot truly
        // absent" from "slot explicitly empty". Numbers and booleans
        // pass through unchanged so e.g. `CountValue = 0` reads as
        // present.
        if (typeof raw === 'string') {
            // STEP logical-unknown markers (`.U.`, `.X.`) read as
            // "no value" per IDS spec — they fail any attribute
            // check, including a bare existence check, so don't
            // surface them as if the slot were populated.
            if (raw === '.U.' || raw === '.X.') continue;
            // Bare boolean tokens (`.T.` / `.F.`) on a schema-typed
            // IfcBoolean attribute slot — resolve to JS boolean so
            // IDS checks comparing against `true` / `false` literals
            // pass without case-sensitive string contortions.
            if (raw === '.T.') {
                result.push({ name: attrName, value: true });
                continue;
            }
            if (raw === '.F.') {
                result.push({ name: attrName, value: false });
                continue;
            }
            const display = raw.startsWith('.') && raw.endsWith('.')
                ? raw.slice(1, -1)
                : raw;
            result.push({ name: attrName, value: display });
        } else if (typeof raw === 'number' || typeof raw === 'boolean') {
            result.push({ name: attrName, value: raw });
        } else if (Array.isArray(raw) && raw.length === 2) {
            // Typed STEP values like IFCREAL(0.0), IFCBOOLEAN(.T.) —
            // return the underlying primitive so attribute existence
            // and value checks can compare it directly.
            const inner = raw[1];
            const tag = String(raw[0]).toUpperCase();
            if (tag.includes('BOOLEAN')) {
                result.push({ name: attrName, value: inner === '.T.' || inner === true });
            } else if (tag.includes('LOGICAL')) {
                if (inner === '.U.' || inner === '.X.') {
                    // UNKNOWN logical → don't surface (treated as absent)
                    continue;
                }
                result.push({ name: attrName, value: inner === '.T.' || inner === true });
            } else if (typeof inner === 'number' || typeof inner === 'boolean') {
                result.push({ name: attrName, value: inner });
            } else if (typeof inner === 'string' && inner) {
                const display = inner.startsWith('.') && inner.endsWith('.')
                    ? inner.slice(1, -1)
                    : inner;
                result.push({ name: attrName, value: display });
            }
        }
    }

    return result;
}

/**
 * Returns named raw attribute pairs for an entity, filtered to display-relevant attributes.
 * Skips structural/reference attributes using the IFC schema. Used by query layer for coercion.
 */
export function getRawNamedAttributes(
    entity: IfcEntity
): Array<{ name: string; raw: IfcAttributeValue }> {
    const attrs = entity.attributes || [];
    const attrNames = getAttributeNames(entity.type);

    const result: Array<{ name: string; raw: IfcAttributeValue }> = [];
    const len = Math.min(attrs.length, attrNames.length);
    for (let i = 0; i < len; i++) {
        const attrName = attrNames[i];
        if (SKIP_DISPLAY_ATTRS.has(attrName)) continue;
        result.push({ name: attrName, raw: attrs[i] });
    }
    return result;
}

interface RootAttrIndices {
    known: boolean;
    globalId: number;
    name: number;
    description: number;
    objectType: number;
    tag: number;
    longName: number;
}

// getAttributeNames() walks the schema registry (an O(types) scan for the
// UPPERCASE STEP names entities carry), so memoise the per-type index lookup.
// There are only a few hundred distinct types but potentially millions of
// entities, keeping the on-demand path cheap even when called per entity.
const rootAttrIndexCache = new Map<string, RootAttrIndices>();

function getRootAttrIndices(type: string): RootAttrIndices {
    let idx = rootAttrIndexCache.get(type);
    if (!idx) {
        const names = getAttributeNames(type);
        idx = {
            known: names.length > 0,
            globalId: names.indexOf('GlobalId'),
            name: names.indexOf('Name'),
            description: names.indexOf('Description'),
            objectType: names.indexOf('ObjectType'),
            tag: names.indexOf('Tag'),
            longName: names.indexOf('LongName'),
        };
        rootAttrIndexCache.set(type, idx);
    }
    return idx;
}

/**
 * Resolve the common IfcRoot-family display attributes (GlobalId, Name,
 * Description, ObjectType, Tag) from an entity's raw attribute array.
 *
 * These are mapped by schema-derived attribute *name*, not fixed index. The
 * fixed indices `[0],[2],[3],[4],[7]` only hold for the IfcElement layout: for
 * a spatial element `attrs[7]` is LongName (not Tag), and for a resource entity
 * like IfcMaterial `attrs[0]` is Name (not GlobalId). Name-mapping keeps all of
 * these correct for every entity type, returning '' for attributes the type
 * does not declare.
 *
 * For types the schema registry does not recognise (e.g. an IFC4x3 infra leaf
 * outside the codegen pin, or a vendor extension) we fall back to the canonical
 * IfcRoot/IfcElement positions so we never regress vs. the old fixed-index path.
 */
export function extractRootAttributesFromEntity(
    entity: IfcEntity
): { globalId: string; name: string; description: string; objectType: string; tag: string } {
    const attrs = entity.attributes || [];
    const enumIdx = entity.enumAttrIndices;
    const idx = getRootAttrIndices(entity.type);
    const pick = (schemaIndex: number, fallbackIndex: number): string => {
        const i = idx.known ? schemaIndex : fallbackIndex;
        const raw = i >= 0 ? attrs[i] : undefined;
        if (typeof raw !== 'string') return '';
        // Unknown-type fallback only: a fixed index can land on a STEP bare-enum
        // token — e.g. a PredefinedType at attr 7 for a non-IfcElement layout —
        // which must not leak into a Tag/Description cell. Reject by token KIND
        // via the extractor's side channel (#1799), not by dotted-string shape:
        // a quoted string that merely looks like an enum ('.USERDEFINED.')
        // survives, exactly matching the Rust server path (string_at accepts
        // AttributeValue::String and rejects ::Enum, #1779). Skipped for known
        // types, whose schema indices point at genuine string slots.
        if (!idx.known && enumIdx !== undefined && enumIdx.includes(i)) return '';
        return raw;
    };
    return {
        globalId: pick(idx.globalId, 0),
        name: pick(idx.name, 2),
        description: pick(idx.description, 3),
        objectType: pick(idx.objectType, 4),
        tag: pick(idx.tag, 7),
    };
}

/**
 * Resolve an entity's LongName (IfcZone, IfcSystem subtypes, IfcSpatialZone,
 * IfcBuildingSystem, …) by schema attribute name. Groups frequently leave Name
 * empty and carry their human label in LongName, so consumers fall back to this
 * for the display label. Returns '' when the type does not declare LongName.
 * (#1075)
 */
export function pickLongName(entity: IfcEntity): string {
    const idx = getRootAttrIndices(entity.type);
    if (!idx.known || idx.longName < 0) return '';
    const raw = (entity.attributes || [])[idx.longName];
    return typeof raw === 'string' ? raw : '';
}

