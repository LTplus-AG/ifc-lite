/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schema-derived relationship attribute slots (#4205).
 *
 * `extractRelFast` (`columnar-parser-relationships.ts`) used to dispatch on a
 * hand-written `typeUpper === 'IFCREL...'` ladder, one branch per STEP
 * keyword, each hardcoding which attribute index carried `RelatingX` and
 * which carried `RelatedY`. Every `IfcRelationship` subtype not in that
 * ladder fell through to a "default" branch that assumed positions 4/5 —
 * wrong for several real subtypes — or was never routed to `extractRelFast`
 * at all (the hand-written gate sets in `columnar-parser-indexes.ts`).
 *
 * This module derives the same information from the codegen-generated
 * schema registries instead: every EXPRESS `IfcRelationship` subtype names
 * its two graph-relevant attributes `RelatingX` (a single reference) and
 * `RelatedY` (a single reference or a list) — a convention the schema
 * itself enforces, not a coincidence to hardcode around. Walking
 * `allAttributes` (root → leaf, the same order the STEP file writes them
 * in) and picking out the first `Relating*`/`Related*` attribute whose
 * EXPRESS type is an entity or a select (never an enum or a defined
 * primitive type — `IfcRelConnectsPathElements.RelatingPriorities` is an
 * `IfcInteger` LIST and `RelatingConnectionType` an enum; neither is a
 * reference) gives the exact byte position to scan to, for every subtype
 * across every bundled schema version, without a per-type table.
 */

import {
    getSchemaRegistryForVersion,
    type SchemaVersionWithRegistry,
    type SchemaRegistry,
} from './generated/schema-registry-by-version.js';

/** One relating/related attribute's position and cardinality. */
export interface RelationshipSlot {
    /** 0-based position AFTER the 4 shared IfcRoot+IfcRelationship attrs
     *  (GlobalId, OwnerHistory, Name, Description) that every
     *  `IfcRelationship` subtype starts with. */
    index: number;
    /** True when the attribute is a LIST/SET (read as a ref list); false
     *  for a single reference. Informational only — `readRefList` already
     *  accepts both forms, so callers may ignore this and always read a
     *  list, taking the first id for a known-single slot. */
    isList: boolean;
}

/** Where to find the relating (one) and related (one-or-many) object
 *  reference(s) inside a concrete `IfcRelationship` subtype's attributes. */
export interface RelationshipSlotPlan {
    relating: RelationshipSlot;
    related: RelationshipSlot;
}

// GlobalId, OwnerHistory, Name, Description — every IfcRoot descendant,
// IfcRelationship included, starts with exactly these 4.
const ROOT_ATTR_COUNT = 4;

// Most-featured schema first: an IFC4X3-only class (IfcRelPositions,
// IfcRelAdheresToElement, …) must resolve even though the parser's own
// codegen pin (`./generated/schema-registry.ts`) is IFC4. A class present
// in more than one bundled version (the overwhelming majority) has an
// identical attribute layout in every version that declares it, so which
// one answers first does not matter for those.
const VERSIONS: readonly SchemaVersionWithRegistry[] = ['IFC4X3', 'IFC4', 'IFC2X3'];

/** A reference-typed EXPRESS attribute points at an entity or a SELECT —
 *  never at an enum or a defined type aliasing a primitive (IfcLabel,
 *  IfcInteger, IfcLengthMeasure, …).
 *
 * `registry.selects` must be checked BEFORE `registry.types`: a SELECT
 * declaration (`TYPE IfcProductSelect = SELECT (...)`) is recorded in
 * *both* — `registry.types['IfcProductSelect']` holds its literal EXPRESS
 * source (`'SELECT (IfcProduct, ...)'`), the same dict slot every plain
 * primitive alias (`IfcLabel`, `IfcInteger`) occupies. Checking `.types`
 * first misclassified every select-typed `Relating*`/`Related*` attribute
 * as a non-reference — `IfcRelDeclares.RelatingContext`/
 * `RelatedDefinitions` (`IfcContext`/`IfcDefinitionSelect`) resolved to no
 * plan at all, caught by `relationship-schema-slots.test.ts` and the
 * `IfcRelDeclares` case in `relationship-subtype-coverage.test.ts`. */
function isReferenceType(registry: SchemaRegistry, typeName: string): boolean {
    if (Object.prototype.hasOwnProperty.call(registry.selects, typeName)) return true;
    if (Object.prototype.hasOwnProperty.call(registry.enums, typeName)) return false;
    if (Object.prototype.hasOwnProperty.call(registry.types, typeName)) return false;
    return true;
}

function computeSlotPlan(registry: SchemaRegistry, entityName: string): RelationshipSlotPlan | undefined {
    const meta = registry.entities[entityName];
    const allAttrs = meta?.allAttributes;
    if (!allAttrs || allAttrs.length <= ROOT_ATTR_COUNT) return undefined;

    let relating: RelationshipSlot | undefined;
    let related: RelationshipSlot | undefined;
    for (let i = ROOT_ATTR_COUNT; i < allAttrs.length; i++) {
        const attr = allAttrs[i];
        if (!isReferenceType(registry, attr.type)) continue;
        const slot: RelationshipSlot = {
            index: i - ROOT_ATTR_COUNT,
            isList: attr.isList || attr.isSet || attr.isArray,
        };
        if (!relating && attr.name.startsWith('Relating')) relating = slot;
        else if (!related && attr.name.startsWith('Related')) related = slot;
    }
    if (!relating || !related) return undefined;
    return { relating, related };
}

const PLAN_CACHE = new Map<string, RelationshipSlotPlan | undefined>();

/**
 * The relating/related attribute slots for a STEP relationship keyword
 * (e.g. `'IFCRELASSIGNSTOACTOR'`), or `undefined` if the type is unknown to
 * every bundled schema, or is an `IfcRelationship` subtype whose layout
 * this convention-based walk cannot resolve (none of the 46 IFC4/IFC4X3
 * concrete subtypes as of writing fall into that second case — see
 * `relationship-schema-slots.test.ts`).
 */
export function getRelationshipSlotPlan(typeUpper: string): RelationshipSlotPlan | undefined {
    const cached = PLAN_CACHE.get(typeUpper);
    if (cached !== undefined || PLAN_CACHE.has(typeUpper)) return cached;

    let plan: RelationshipSlotPlan | undefined;
    for (const version of VERSIONS) {
        const registry = getSchemaRegistryForVersion(version);
        const canonical = Object.keys(registry.entities).find(n => n.toUpperCase() === typeUpper);
        if (!canonical) continue;
        plan = computeSlotPlan(registry, canonical);
        if (plan) break;
    }
    PLAN_CACHE.set(typeUpper, plan);
    return plan;
}

function isSubtypeOfIfcRelationship(registry: SchemaRegistry, name: string): boolean {
    let cursor: SchemaRegistry['entities'][string] | undefined = registry.entities[name];
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.name)) {
        if (cursor.name === 'IfcRelationship') return true;
        seen.add(cursor.name);
        cursor = cursor.parent ? registry.entities[cursor.parent] : undefined;
    }
    return false;
}

const CONCRETE_TYPES_CACHE = new Map<SchemaVersionWithRegistry, ReadonlySet<string>>();

/** Every concrete (non-abstract) `IfcRelationship` subtype STEP keyword in
 *  one schema version, upper-cased. */
export function getConcreteRelationshipTypes(version: SchemaVersionWithRegistry): ReadonlySet<string> {
    const cached = CONCRETE_TYPES_CACHE.get(version);
    if (cached) return cached;
    const registry = getSchemaRegistryForVersion(version);
    const result = new Set<string>();
    for (const [name, meta] of Object.entries(registry.entities)) {
        if (meta.isAbstract) continue;
        if (isSubtypeOfIfcRelationship(registry, name)) result.add(name.toUpperCase());
    }
    CONCRETE_TYPES_CACHE.set(version, result);
    return result;
}

let UNION_CACHE: ReadonlySet<string> | undefined;

/**
 * The schema-derived GATE: every concrete `IfcRelationship` subtype STEP
 * keyword across every bundled schema version, upper-cased. Replaces a
 * hand-written enumeration that #3964, #3237, #1075 and #4205 each found
 * missing one more class from.
 */
export function getAllConcreteRelationshipTypes(): ReadonlySet<string> {
    if (UNION_CACHE) return UNION_CACHE;
    const union = new Set<string>();
    for (const version of VERSIONS) {
        for (const t of getConcreteRelationshipTypes(version)) union.add(t);
    }
    UNION_CACHE = union;
    return union;
}
