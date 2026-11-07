/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which type an element has, and which definitions a type has, in the current
 * model, without reading every typing relationship from the source (#9192).
 *
 * The parsed graph already says which relationship names which element, and
 * reading all of them from block-compressed source cost seconds on the first
 * selection of a large model. So a relationship is read in only two cases:
 *
 *   - the graph cannot vouch for it: an edit touched it, the session created
 *     it, the parser recorded no edge for it (a record the byte reader could
 *     not use, or a store whose graph is not complete yet), or it names a
 *     definition that is not one, or no longer is, after an edit. These are read once
 *     per revision, so they keep refusing for the whole model as they always did;
 *   - a lookup needs it: it names the element or type being asked about.
 *
 * A source-free store has nothing to read and no relationship the graph can
 * vouch for, so every row there resolves from the view.
 */

import { binarySearchU32, iterateEffectiveEntities, RelationshipType, type RelationshipEdges } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { getReference } from './attribute-helpers.js';
import { effectiveMetadataRecord, type MetadataReadView } from './effective-metadata-record.js';
import { propertyDefinitionsInModel } from './property-definition-members.js';
import { getInheritanceChain, normalizeIfcTypeName } from './ifc-schema.js';

const MAX_RELATIONSHIPS = 65_536;
const MAX_RELATION_REFERENCES = 262_144;

export class CurrentQuantityRefusal extends Error {}

export function refIds(value: unknown, max = MAX_RELATION_REFERENCES, required = false): number[] {
    if (value === null || (Array.isArray(value) && value.length === 0)) {
        if (required) throw new CurrentQuantityRefusal('Native required quantity references are unreadable');
        return [];
    }
    if (Array.isArray(value) && value.length > max) throw new CurrentQuantityRefusal('Native quantity references exceed the read limit');
    if (!Array.isArray(value)) throw new CurrentQuantityRefusal('Native quantity references are unreadable');
    const ids: number[] = [];
    for (const valueId of value) {
        // Only schema reference lists admit public StoreEditor '#id' tokens.
        // Reject partial tokens before the shared reference decoder is called.
        const id = typeof valueId === 'number' ? valueId
            : typeof valueId === 'string' && /^#\d+$/.test(valueId) ? getReference(valueId) : undefined;
        if (id === undefined || !Number.isSafeInteger(id) || id <= 0) {
            throw new CurrentQuantityRefusal('Native quantity references are unreadable');
        }
        ids.push(id);
    }
    return ids;
}

/** One relationship as this reader needs it: null when it holds nothing usable. */
type RelationRead = { byType: boolean; members: number[]; targets: number[] } | null;

function readRelation(store: IfcDataStore, expressId: number, view: MetadataReadView): RelationRead {
    const record = effectiveMetadataRecord(store, expressId, view);
    if (!record) throw new CurrentQuantityRefusal('Native type relationship is unreadable');
    const target = record.attributes[5];
    const members = refIds(record.attributes[4], MAX_RELATION_REFERENCES, true);
    const byType = record.type.toUpperCase() === 'IFCRELDEFINESBYTYPE';
    // RelatingPropertyDefinition may be a set of definitions (#7681); a type is always one.
    const targets = byType
        ? (typeof target === 'number' && Number.isSafeInteger(target) && target > 0 ? [target] : [])
        : propertyDefinitionsInModel(store, target, view);
    // A non-empty set none of whose members is a property definition holds
    // no definition for this reader to use; it is not an unreadable record.
    if (targets.length === 0 && !byType && Array.isArray(target) && target.length > 0) return null;
    if (targets.length === 0) throw new CurrentQuantityRefusal('Native type relationship target is unreadable');
    return { byType, members, targets };
}

interface GraphFacts {
    /** Per typing relationship, the edges the parser recorded for it, repeats included. */
    counts: Map<number, number>;
    /** Definition relationships naming something the parsed index does not class as a property definition. */
    unverified: Set<number>;
}
const graphFacts = new WeakMap<RelationshipEdges, GraphFacts>();

/**
 * What the graph can say about every typing relationship, once per graph. Reads no source.
 *
 * A definition set counts only its members that are effective property definitions (#7681),
 * while the graph holds an edge for every reference written. A relationship naming anything
 * else (a wall, a dangling id) is therefore marked so its record is read, as it was before.
 */
function readGraphFacts(store: IfcDataStore, edges: RelationshipEdges): GraphFacts {
    const known = graphFacts.get(edges);
    if (known) return known;
    const counts = new Map<number, number>();
    const unverified = new Set<number>();
    const { edgeTypes, edgeRelIds, shadowedEdgeIndex, shadowedGroupOffsets, shadowedRelIds } = edges;
    const typing = (edge: number) => edgeTypes[edge] === RelationshipType.DefinesByType || edgeTypes[edge] === RelationshipType.DefinesByProperties;
    const shadowedOf = (edge: number): ArrayLike<number> => {
        const group = shadowedEdgeIndex ? binarySearchU32(shadowedEdgeIndex, edge) : -1;
        return group === -1 || !shadowedGroupOffsets || !shadowedRelIds ? []
            : shadowedRelIds.subarray(shadowedGroupOffsets[group], shadowedGroupOffsets[group + 1]);
    };
    for (let edge = 0; edge < edgeTypes.length; edge++) {
        if (!typing(edge)) continue;
        for (const id of [edgeRelIds[edge], ...Array.from(shadowedOf(edge))]) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const definitionClass = new Map<string, boolean>();
    for (const [source, offset] of edges.offsets) {
        const end = offset + (edges.counts.get(source) ?? 0);
        let definition: boolean | undefined;
        for (let edge = offset; edge < end; edge++) {
            if (edgeTypes[edge] !== RelationshipType.DefinesByProperties) continue;
            definition ??= isDefinitionClass(store, source, definitionClass);
            if (!definition) for (const id of [edgeRelIds[edge], ...Array.from(shadowedOf(edge))]) unverified.add(id);
        }
    }
    const facts = { counts, unverified };
    graphFacts.set(edges, facts);
    return facts;
}

function isDefinitionClass(store: IfcDataStore, id: number, memo: Map<string, boolean>): boolean {
    // @raw-entity-enumeration-ok the parsed class of one relating definition, before any edit; edits are applied per revision
    const type = (store.entityIndex.byId.get(id) ?? store.deferredEntityIndex?.get(id))?.type;
    if (!type) return false;
    let result = memo.get(type);
    if (result === undefined) {
        result = getInheritanceChain(normalizeIfcTypeName(type)).includes('IfcPropertySetDefinition');
        memo.set(type, result);
    }
    return result;
}

interface Contribution { order: number; targets: readonly number[] }

export interface CurrentTypeRelationships {
    /** Types assigned to an element, in effective row order. */
    typesOf(entityId: number): readonly number[];
    /** Definitions a relationship attaches to a type, in effective row order, each once. */
    definitionsOf(typeId: number): readonly number[];
}

/**
 * Walk the effective rows (no source read) and read only what the graph cannot
 * vouch for. Refuses, as a whole, on what makes the model's relationships
 * unusable: too many rows, too many references, or an unreadable row of those read.
 */
export function resolveCurrentTypeRelationships(store: IfcDataStore, view: MetadataReadView): CurrentTypeRelationships {
    const graph = store.relationships;
    const facts = store.source?.length && graph ? readGraphFacts(store, graph.forward) : undefined;
    const counts = facts?.counts;
    const retypes = view.getTypeMutations?.();
    // A definition deleted or retyped by an edit drops out of the sets naming it, so those are read.
    // A view that cannot list its deletions gets every definition relationship read.
    const tombstones = view.getTombstones?.();
    const redefined = new Set<number>();
    if (facts) {
        for (const id of [...(tombstones ?? []), ...(retypes?.keys() ?? [])]) {
            for (const edge of graph.forward.getEdges(id, RelationshipType.DefinesByProperties)) {
                for (const relationshipId of [edge.relationshipId, ...(edge.shadowedRelationshipIds ?? [])]) redefined.add(relationshipId);
            }
        }
    }
    const vouched = new Map<number, number>();
    const editedTypes = new Map<number, Contribution[]>();
    const editedSets = new Map<number, Contribution[]>();
    let relationshipCount = 0;
    let referenceCount = 0;
    for (const row of iterateEffectiveEntities(store, view, ['IfcRelDefinesByType', 'IfcRelDefinesByProperties'])) {
        const order = ++relationshipCount;
        if (relationshipCount > MAX_RELATIONSHIPS) throw new CurrentQuantityRefusal('Native type relationship inventory exceeds the read limit');
        const touched = row.overlayCreated || retypes?.has(row.expressId)
            || view.getPositionalMutationsForEntity(row.expressId) !== null
            || view.getAttributeMutationsForEntity(row.expressId).length > 0
            || (row.type === 'IFCRELDEFINESBYPROPERTIES' && (!tombstones || facts?.unverified.has(row.expressId) || redefined.has(row.expressId)));
        const edges = touched ? undefined : counts?.get(row.expressId);
        if (edges !== undefined) {
            vouched.set(row.expressId, order);
            referenceCount += edges;
        } else {
            const relation = readRelation(store, row.expressId, view);
            if (!relation) continue;
            // Both sides count: a set of N definitions on M objects is N x M edges.
            referenceCount += relation.members.length * relation.targets.length;
            const map = relation.byType ? editedTypes : editedSets;
            for (const member of new Set(relation.members)) {
                const rows = map.get(member);
                if (rows) rows.push({ order, targets: relation.targets });
                else map.set(member, [{ order, targets: relation.targets }]);
            }
        }
        if (referenceCount > MAX_RELATION_REFERENCES) throw new CurrentQuantityRefusal('Native type relationship references exceed the read limit');
    }

    // One read per relationship, so an element-by-element walk stays linear in a
    // relationship naming many of them.
    const reads = new Map<number, RelationRead>();
    const readOnce = (id: number): RelationRead => {
        if (reads.has(id)) return reads.get(id)!;
        const value = readRelation(store, id, view);
        reads.set(id, value);
        return value;
    };
    const lookup = (edited: Map<number, Contribution[]>, type: RelationshipType) => {
        const memo = new Map<number, readonly number[]>();
        return (id: number): readonly number[] => {
            const known = memo.get(id);
            if (known) return known;
            const rows = [...(edited.get(id) ?? [])];
            if (counts) {
                for (const edge of graph.inverse.getEdges(id, type)) {
                    for (const relationshipId of [edge.relationshipId, ...(edge.shadowedRelationshipIds ?? [])]) {
                        const order = vouched.get(relationshipId);
                        const targets = order === undefined ? undefined : readOnce(relationshipId)?.targets;
                        if (order !== undefined && targets) rows.push({ order, targets });
                    }
                }
            }
            const ids = [...new Set(rows.sort((a, b) => a.order - b.order).flatMap(row => row.targets))];
            memo.set(id, ids);
            return ids;
        };
    };
    return {
        typesOf: lookup(editedTypes, RelationshipType.DefinesByType),
        definitionsOf: lookup(editedSets, RelationshipType.DefinesByProperties),
    };
}
