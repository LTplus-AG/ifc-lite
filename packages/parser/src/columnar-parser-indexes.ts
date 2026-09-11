/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Index building and type classification for columnar parsing.
 *
 * Pre-computed type sets for O(1) lookups, type-checking predicates,
 * and interface definitions for spatial and entity-by-ID indexes.
 */

import type { EntityRef } from './types.js';
import {
    RelationshipType,
    QuantityType,
} from '@ifc-lite/data';

export type { SpatialIndex } from '@ifc-lite/data';

/**
 * Entity-by-ID lookup interface. Supports both Map<number, EntityRef> (legacy)
 * and CompactEntityIndex (memory-optimized typed arrays with LRU cache).
 */
export type EntityByIdIndex = {
    get(expressId: number): EntityRef | undefined;
    has(expressId: number): boolean;
    readonly size: number;
    keys(): IterableIterator<number>;
    values(): IterableIterator<EntityRef>;
    entries(): IterableIterator<[number, EntityRef]>;
    forEach(callback: (value: EntityRef, key: number) => void): void;
    [Symbol.iterator](): IterableIterator<[number, EntityRef]>;
};

// Pre-computed type sets for O(1) lookups.
//
// getCategory() in columnar-parser.ts matches this set against the FULL
// inheritance chain (isSubtypeOfAny), so IFCELEMENT below makes EVERY
// IfcElement subtype classify as CAT_GEOMETRY schema-driven. The previous
// hardcoded leaf enumeration drifted: IfcCovering (and IfcChimney,
// IfcShadingDevice, IfcElementAssembly, …) fell through to CAT_RELEVANT,
// skipped batchExtractGlobalIdAndName, and were stored with empty
// GlobalId/Name — picked coverings showed "IFCCOVERING" with no GUID
// (schependomlaan regression). Spatial types are unaffected because
// CAT_SPATIAL is checked first and none of them inherit from IfcElement.
export const GEOMETRY_TYPES = new Set([
    'IFCELEMENT',
    // Leaf names kept for direct O(1) hits on the common types (and as a
    // safety net for STEP files whose types miss the schema registry).
    'IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCDOOR', 'IFCWINDOW', 'IFCSLAB',
    'IFCCOLUMN', 'IFCBEAM', 'IFCROOF', 'IFCSTAIR', 'IFCSTAIRFLIGHT',
    'IFCRAILING', 'IFCRAMP', 'IFCRAMPFLIGHT', 'IFCPLATE', 'IFCMEMBER',
    'IFCCURTAINWALL', 'IFCFOOTING', 'IFCPILE', 'IFCBUILDINGELEMENTPROXY',
    'IFCFURNISHINGELEMENT', 'IFCFLOWSEGMENT', 'IFCFLOWTERMINAL',
    'IFCFLOWCONTROLLER', 'IFCFLOWFITTING', 'IFCSPACE', 'IFCOPENINGELEMENT',
    'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCCOVERING',
]);

// Map IFC relationship type strings to RelationshipType enum
// MUST cover ALL RelationshipType enum values (15 types total)
export const REL_TYPE_MAP: Record<string, RelationshipType> = {
    'IFCRELCONTAINEDINSPATIALSTRUCTURE': RelationshipType.ContainsElements,
    'IFCRELAGGREGATES': RelationshipType.Aggregates,
    // IfcRelNests is semantically a decomposition relationship; map it
    // onto the same edge bucket so partOf checks for either traverse
    // the same graph. This is the PRIMARY edge only — SECONDARY_REL_TYPE_MAP
    // below also records every IfcRelNests edge under the distinct
    // RelationshipType.Nests, so a caller that needs to tell "nested" apart
    // from "aggregated" can, without disturbing anything that already reads
    // the Aggregates bucket (#4205).
    'IFCRELNESTS': RelationshipType.Aggregates,
    'IFCRELDEFINESBYPROPERTIES': RelationshipType.DefinesByProperties,
    'IFCRELDEFINESBYTYPE': RelationshipType.DefinesByType,
    'IFCRELASSOCIATESMATERIAL': RelationshipType.AssociatesMaterial,
    'IFCRELASSOCIATESCLASSIFICATION': RelationshipType.AssociatesClassification,
    'IFCRELASSOCIATESDOCUMENT': RelationshipType.AssociatesDocument,
    'IFCRELVOIDSELEMENT': RelationshipType.VoidsElement,
    'IFCRELFILLSELEMENT': RelationshipType.FillsElement,
    'IFCRELCONNECTSPATHELEMENTS': RelationshipType.ConnectsPathElements,
    'IFCRELCONNECTSELEMENTS': RelationshipType.ConnectsElements,
    'IFCRELCONNECTSPORTTOELEMENT': RelationshipType.ConnectsPortToElement,
    'IFCRELCONNECTSPORTS': RelationshipType.ConnectsPorts,
    'IFCRELSPACEBOUNDARY': RelationshipType.SpaceBoundary,
    'IFCRELASSIGNSTOGROUP': RelationshipType.AssignsToGroup,
    // Subtype of IfcRelAssignsToGroup (adds a Factor); same RelatingGroup /
    // RelatedObjects membership semantics, so it shares this PRIMARY edge
    // type — existing group-membership traversal (extractGroupMembersOnDemand,
    // extractRelationshipsOnDemand) is unchanged. SECONDARY_REL_TYPE_MAP below
    // also records it under the distinct RelationshipType.AssignsToGroupByFactor
    // so a caller can tell it apart from a plain assignment and look its
    // Factor value up on the relationship entity itself (#4205).
    'IFCRELASSIGNSTOGROUPBYFACTOR': RelationshipType.AssignsToGroup,
    'IFCRELASSIGNSTOPRODUCT': RelationshipType.AssignsToProduct,
    'IFCRELREFERENCEDINSPATIALSTRUCTURE': RelationshipType.ReferencedInSpatialStructure,
};

/**
 * A second, distinct edge recorded IN ADDITION TO the primary one above for
 * the two IfcRelationship subtypes that {@link REL_TYPE_MAP} intentionally
 * folds into a broader bucket for backward compatibility. Absent from this
 * map means "no second edge" — every STEP keyword handled here still gets
 * its primary edge from `REL_TYPE_MAP`. Consumed by the relationship-parsing
 * loop in `columnar-parser.ts` right after the primary-edge loop.
 *
 * Keeping both a broad bucket (existing consumers keep working unchanged)
 * and a precise one (a new consumer can ask for exactly this STEP class) is
 * cheaper and lower-risk than migrating every existing Aggregates/AssignsToGroup
 * consumer to also check the narrower type — see #4205, which named
 * `spatial-hierarchy-builder.ts`, `decomposition.ts`, `owning-project.ts` and
 * the IDS `partOf`/ancestors bridge as call sites that must keep seeing
 * IfcRelNests through the Aggregates bucket.
 */
export const SECONDARY_REL_TYPE_MAP: Record<string, RelationshipType> = {
    'IFCRELNESTS': RelationshipType.Nests,
    'IFCRELASSIGNSTOGROUPBYFACTOR': RelationshipType.AssignsToGroupByFactor,
};

export const QUANTITY_TYPE_MAP: Record<string, QuantityType> = {
    'IFCQUANTITYLENGTH': QuantityType.Length,
    'IFCQUANTITYAREA': QuantityType.Area,
    'IFCQUANTITYVOLUME': QuantityType.Volume,
    'IFCQUANTITYCOUNT': QuantityType.Count,
    'IFCQUANTITYWEIGHT': QuantityType.Weight,
    'IFCQUANTITYTIME': QuantityType.Time,
    // IFC4X3 added IfcQuantityNumber; older schemas never emit it.
    'IFCQUANTITYNUMBER': QuantityType.Number,
};

// Types needed for spatial hierarchy (small subset)
export const SPATIAL_TYPES = new Set([
    'IFCPROJECT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCSPACE',
    'IFCFACILITY', 'IFCFACILITYPART',
    'IFCBRIDGE', 'IFCBRIDGEPART',
    'IFCROAD', 'IFCROADPART',
    'IFCRAILWAY', 'IFCRAILWAYPART',
    'IFCMARINEFACILITY',
]);

// Relationship types needed for hierarchy and structural relationships
export const HIERARCHY_REL_TYPES = new Set([
    'IFCRELAGGREGATES', 'IFCRELCONTAINEDINSPATIALSTRUCTURE',
    'IFCRELDEFINESBYTYPE',
    // IfcRelNests is a decomposition edge — IDS partOf checks for it
    // expect to traverse the same graph as IfcRelAggregates.
    'IFCRELNESTS',
    // Structural relationships (voids, fills, connections, groups)
    'IFCRELVOIDSELEMENT', 'IFCRELFILLSELEMENT',
    'IFCRELCONNECTSPATHELEMENTS', 'IFCRELCONNECTSELEMENTS',
    // Plant topology. This set is the GATE — a relationship type missing here
    // is never collected and so never reaches `extractRelFast`, which is why
    // ports were invisible to the relationship graph even though the entities
    // themselves were parsed.
    'IFCRELCONNECTSPORTTOELEMENT', 'IFCRELCONNECTSPORTS',
    'IFCRELSPACEBOUNDARY',
    // IfcRelAssignsToGroupByFactor is a distinct STEP keyword (subtype of
    // IfcRelAssignsToGroup); omitting it here means it never reaches
    // relationshipRefs / extractRelFast, so every group/zone/system
    // membership assigned through it is silently dropped.
    'IFCRELASSIGNSTOGROUP', 'IFCRELASSIGNSTOGROUPBYFACTOR', 'IFCRELASSIGNSTOPRODUCT',
    'IFCRELREFERENCEDINSPATIALSTRUCTURE',
]);

// Relationship types for on-demand property loading
export const PROPERTY_REL_TYPES = new Set([
    'IFCRELDEFINESBYPROPERTIES',
]);

// Relationship types for on-demand classification/material loading
export const ASSOCIATION_REL_TYPES = new Set([
    'IFCRELASSOCIATESCLASSIFICATION', 'IFCRELASSOCIATESMATERIAL',
    'IFCRELASSOCIATESDOCUMENT',
]);

// Attributes to skip in extractAllEntityAttributes (shown elsewhere or non-displayable)
export const SKIP_DISPLAY_ATTRS = new Set(['GlobalId', 'OwnerHistory', 'ObjectPlacement', 'Representation', 'HasPropertySets', 'RepresentationMaps']);

// Property-related entity types for on-demand extraction
export const PROPERTY_ENTITY_TYPES = new Set([
    'IFCPROPERTYSET', 'IFCELEMENTQUANTITY',
    'IFCPROPERTYSINGLEVALUE', 'IFCPROPERTYENUMERATEDVALUE',
    'IFCPROPERTYBOUNDEDVALUE', 'IFCPROPERTYTABLEVALUE',
    'IFCPROPERTYLISTVALUE', 'IFCPROPERTYREFERENCEVALUE',
    'IFCQUANTITYLENGTH', 'IFCQUANTITYAREA', 'IFCQUANTITYVOLUME',
    'IFCQUANTITYCOUNT', 'IFCQUANTITYWEIGHT', 'IFCQUANTITYTIME',
    'IFCQUANTITYNUMBER',
]);

export const PROPERTY_CONTAINER_TYPES = new Set([
    'IFCPROPERTYSET',
    'IFCELEMENTQUANTITY',
]);

export function isIfcTypeLikeEntity(typeUpper: string): boolean {
    return typeUpper.endsWith('TYPE') || typeUpper.endsWith('STYLE');
}
