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
 *     not use, or a store whose graph is not complete yet: the early store, which
 *     refuses as still loading past LOADING_ROW_LIMIT rows), or it is a
 *     definition set naming something other than a definition (see
 *     readGraphFacts). These are read once per revision, so they keep refusing
 *     for the whole model as they always did;
 *   - a lookup needs it: it names the element or type being asked about.
 *
 * The byte reader records edges for a relationship only when its related list
 * and relating value read cleanly, so the edges a relationship has are every
 * reference it holds in those two attributes. A record it would misread (a
 * nested or typed value in the list, say) gets no edges at all and is read up
 * front (#9192).
 *
 * One more case is read only when it decides the answer: a definition relationship the graph
 * over-counts because an edit removed a definition it names (or the view cannot list deletions)
 * is read when that upper bound would cross the reference budget, so the budget stays exact.
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

/**
 * The bounds on one model's typing and definition relationships (#9192). The largest real models
 * in the fixture manifest need 92,432 rows (BWK) and 140,475 references (Holter); a first read
 * there takes about 0.1 s through the graph. A store the graph cannot vouch for reads every row
 * from source (about 45 us each on those models), so the row bound also caps that walk near 6 s.
 */
const MAX_RELATIONSHIPS = 131_072;
const MAX_RELATION_REFERENCES = 262_144;
/**
 * The row bound before #9192 raised it, kept for the store emitted before the definition edges
 * exist. The viewer makes that store active at spatial-ready time (`onSpatialReady`) while property
 * parsing goes on; its graph has typing edges but no definition edges, so every definition
 * relationship there is read from source. The Properties panel runs this walk synchronously in
 * render (useInheritedTypeQuantities), on the UI thread. Past this many rows that store refuses as
 * still loading, without reading a relationship, and the full store answers once it replaces it.
 * Measured there on a first selection: Holter 1.6-1.7 s and BWK 1.6 s to answer, against 1.3-1.4 s
 * and 1.1-1.2 s for the refusal at this bound before #9192. Below it the early store still answers.
 */
const LOADING_ROW_LIMIT = 65_536;

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
    /** Definition relationships with an edge from something that is not a property definition. */
    irregular: Set<number>;
}
const graphFacts = new WeakMap<RelationshipEdges, GraphFacts>();

/**
 * What the graph can say about every typing relationship, once per graph. Reads no source.
 *
 * A definition set naming a non-definition is marked: the graph has an edge per member, but a
 * read counts only the effective property definitions (#7681), so the reference budget needs
 * the read. Such a record is then read like one with no edges.
 */
function readGraphFacts(store: IfcDataStore, edges: RelationshipEdges): GraphFacts {
    const known = graphFacts.get(edges);
    if (known) return known;
    const counts = new Map<number, number>();
    const irregular = new Set<number>();
    const { edgeTypes, edgeRelIds, shadowedEdgeIndex, shadowedGroupOffsets, shadowedRelIds } = edges;
    const shadowed = shadowedEdgeIndex && shadowedGroupOffsets && shadowedRelIds
        ? { index: shadowedEdgeIndex, offsets: shadowedGroupOffsets, ids: shadowedRelIds } : undefined;
    const eachRelationship = (edge: number, visit: (id: number) => void) => {
        visit(edgeRelIds[edge]);
        const group = shadowed ? binarySearchU32(shadowed.index, edge) : -1;
        if (!shadowed || group === -1) return;
        for (let i = shadowed.offsets[group]; i < shadowed.offsets[group + 1]; i++) visit(shadowed.ids[i]);
    };
    const count = (id: number) => { counts.set(id, (counts.get(id) ?? 0) + 1); };
    const mark = (id: number) => { irregular.add(id); };
    const classes = new Map<string, boolean>();
    for (const [source, offset] of edges.offsets) {
        const end = offset + (edges.counts.get(source) ?? 0);
        let definition: boolean | undefined;
        for (let edge = offset; edge < end; edge++) {
            const kind = edgeTypes[edge];
            if (kind === RelationshipType.DefinesByType) {
                eachRelationship(edge, count);
            } else if (kind === RelationshipType.DefinesByProperties) {
                definition ??= hasAncestor(store, source, 'IfcPropertySetDefinition', classes);
                eachRelationship(edge, definition ? count : (id) => { count(id); mark(id); });
            }
        }
    }
    const facts = { counts, irregular };
    graphFacts.set(edges, facts);
    return facts;
}

function hasAncestor(store: IfcDataStore, id: number, ancestor: string, memo: Map<string, boolean>): boolean {
    // @raw-entity-enumeration-ok the parsed class of one relating entity, before any edit; edits are applied per revision
    const type = (store.entityIndex.byId.get(id) ?? store.deferredEntityIndex?.get(id))?.type;
    if (!type) return false;
    const key = `${type}:${ancestor}`;
    let result = memo.get(key);
    if (result === undefined) {
        result = getInheritanceChain(normalizeIfcTypeName(type)).includes(ancestor);
        memo.set(key, result);
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
 * The store emitted before property parsing finished (`relationshipsPending`) has no definition
 * edges, so every definition relationship would be read from source. Past LOADING_ROW_LIMIT rows,
 * with definition relationships among them, that read is refused until the full store arrives, as
 * main refused every model past that bound. Counts rows only; reads no relationship.
 */
function refuseWhileDefinitionsLoad(store: IfcDataStore, view: MetadataReadView): void {
    let rows = 0;
    let definitions = false;
    for (const row of iterateEffectiveEntities(store, view, ['IfcRelDefinesByType', 'IfcRelDefinesByProperties'])) {
        rows++;
        if (row.type === 'IFCRELDEFINESBYPROPERTIES') definitions = true;
        if (rows > LOADING_ROW_LIMIT && definitions) {
            throw new CurrentQuantityRefusal(`Native type relationships are still loading (more than ${LOADING_ROW_LIMIT} relationships)`);
        }
    }
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
    // Only the parser's spatial-ready store says so. A complete store whose graph happens to hold
    // no definition edge (a model with none, plus one a view created) is never replaced, so it
    // answers, within MAX_RELATIONSHIPS, rather than staying "still loading" (#9192).
    if (store.relationshipsPending) refuseWhileDefinitionsLoad(store, view);
    const retypes = view.getTypeMutations?.();
    // A definition deleted or retyped by an edit drops out of the sets naming it, so the graph
    // over-counts those relationships, as it does every definition relationship of a view that
    // cannot list its deletions. The graph still names every element of them.
    const tombstones = view.getTombstones?.();
    const redefined = new Set<number>();
    if (facts) {
        for (const id of [...(tombstones ?? []), ...(retypes?.keys() ?? [])]) {
            for (const edge of graph.forward.getEdges(id, RelationshipType.DefinesByProperties)) {
                for (const relationshipId of [edge.relationshipId, ...(edge.shadowedRelationshipIds ?? [])]) redefined.add(relationshipId);
            }
        }
    }
    // One read per relationship, refusal included, so an element-by-element walk stays linear
    // in a relationship naming many of them and a refused one is not read again this revision.
    const reads = new Map<number, RelationRead | CurrentQuantityRefusal>();
    const readOnce = (id: number): RelationRead => {
        let value = reads.get(id);
        if (value === undefined && !reads.has(id)) {
            try { value = readRelation(store, id, view); } catch (error) {
                if (!(error instanceof CurrentQuantityRefusal)) throw error;
                value = error;
            }
            reads.set(id, value);
        }
        if (value instanceof CurrentQuantityRefusal) throw value;
        return value ?? null;
    };
    const vouched = new Map<number, number>();
    // Over-counted rows enter the budget at their graph count, an upper bound of what a read
    // counts, and are read only when that bound would cross the budget.
    const uncertain: Array<{ id: number; bound: number }> = [];
    let uncertainBound = 0;
    const editedTypes = new Map<number, Contribution[]>();
    const editedSets = new Map<number, Contribution[]>();
    let relationshipCount = 0;
    let referenceCount = 0;
    for (const row of iterateEffectiveEntities(store, view, ['IfcRelDefinesByType', 'IfcRelDefinesByProperties'])) {
        const order = ++relationshipCount;
        if (relationshipCount > MAX_RELATIONSHIPS) throw new CurrentQuantityRefusal(`Native type relationship inventory exceeds the read limit of ${MAX_RELATIONSHIPS} relationships`);
        const touched = row.overlayCreated || retypes?.has(row.expressId)
            || view.getPositionalMutationsForEntity(row.expressId) !== null
            || view.getAttributeMutationsForEntity(row.expressId).length > 0
            || facts?.irregular.has(row.expressId);
        const edges = touched ? undefined : counts?.get(row.expressId);
        if (edges !== undefined) {
            vouched.set(row.expressId, order);
            if (row.type === 'IFCRELDEFINESBYPROPERTIES' && (!tombstones || redefined.has(row.expressId))) {
                uncertain.push({ id: row.expressId, bound: edges });
                uncertainBound += edges;
            } else {
                referenceCount += edges;
            }
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
        while (referenceCount + uncertainBound > MAX_RELATION_REFERENCES && uncertain.length > 0) {
            const next = uncertain.shift()!;
            uncertainBound -= next.bound;
            const relation = readOnce(next.id);
            if (relation) referenceCount += relation.members.length * relation.targets.length;
        }
        if (referenceCount > MAX_RELATION_REFERENCES) throw new CurrentQuantityRefusal(`Native type relationship references exceed the read limit of ${MAX_RELATION_REFERENCES} references`);
    }

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
