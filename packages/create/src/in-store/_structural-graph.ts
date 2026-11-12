/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { iterateEffectiveEntityIds, type StoreEditor } from '@ifc-lite/mutations';
import { getSchemaRegistryForVersion, type IfcDataStore, type SchemaRegistry } from '@ifc-lite/parser';
import { asRef, createStyleEntityReader, type StyleEntity } from './style-entity-reader.js';

/** The ownership boundary is attribute-based: references to other structural
 * roots, placement parents and representation contexts are never owned. */
const OWNED = new Set(['ObjectPlacement', 'Representation', 'Axis', 'AxisDirection',
  'AppliedCondition', 'ConditionCoordinateSystem', 'AppliedLoad', 'OrientationOf2DPlane',
  'RelativePlacement', 'Location', 'RefDirection', 'Representations', 'Items',
  'EdgeStart', 'EdgeEnd', 'VertexGeometry', 'Bounds', 'Bound', 'Polygon',
  'AdditionalConditions', 'ConnectionConstraint', 'SharedPlacement',
  'EdgeElement', 'EdgeList', 'FaceSurface', 'Position', 'Values', 'Points', 'Segments', 'ParentCurve']);

type EntityMetadata = SchemaRegistry['entities'][string];
type AttributeMetadata = NonNullable<EntityMetadata['allAttributes']>[number];
interface StructuralReader {
  schema: 'IFC2X3' | 'IFC4' | 'IFC4X3';
  registry: SchemaRegistry;
  read(id: number): StyleEntity | undefined;
  meta(type: string): EntityMetadata | undefined;
  edges(id: number, owned?: boolean): { target: number; index: number; attribute: AttributeMetadata }[];
  refs(value: unknown): number[];
  requireStructural(id: number): StyleEntity;
}

export function structuralReader(store: IfcDataStore, editor: StoreEditor): StructuralReader {
  const schema = store.schemaVersion ?? 'IFC4';
  if (schema !== 'IFC2X3' && schema !== 'IFC4' && schema !== 'IFC4X3') {
    throw new Error(`structural edit/remove: unsupported schema ${schema}`);
  }
  const registry = getSchemaRegistryForVersion(schema);
  const source = createStyleEntityReader(store, editor);
  const cache = new Map<number, StyleEntity | undefined>();
  const read = (id: number) => {
    if (!cache.has(id)) cache.set(id, source(id) ?? undefined);
    return cache.get(id);
  };
  const entities = new Map(Object.values(registry.entities).map(e => [e.name.toUpperCase(), e]));
  const meta = (type: string) => entities.get(type.toUpperCase());
  const isReference = (type: string, seen = new Set<string>()): boolean => {
    if (registry.entities[type]) return true;
    if (seen.has(type)) return false;
    seen.add(type);
    return (registry.selects[type] ?? []).some(t => isReference(t, seen));
  };
  const refs = (value: unknown): number[] => (Array.isArray(value) ? value : [value])
    .flatMap(v => { const id = asRef(v); return id === null ? [] : [id]; });
  const edges = (id: number, owned = false) => {
    const record = read(id);
    if (!record) return [];
    return (meta(record.type)?.allAttributes ?? []).flatMap((a, index) =>
      isReference(a.type) && (!owned || OWNED.has(a.name))
        ? refs(record.attributes[index]).map(target => ({ target, index, attribute: a })) : []);
  };
  const requireStructural = (id: number) => {
    const record = read(id);
    const type = record && meta(record.type);
    const chain = [...(type?.inheritanceChain ?? []), type?.name ?? ''];
    const structural = chain.some(t => /^(IfcStructural|IfcBoundary|IfcRelConnectsStructural)/.test(t));
    const structuralAssignment = type?.name === 'IfcRelAssignsToGroup'
      && edges(id).some(e => e.attribute.name === 'RelatingGroup'
        && meta(read(e.target)?.type ?? '')?.name.startsWith('IfcStructural'));
    if (!record || !structural && !structuralAssignment) {
      throw new Error(`structural edit/remove: #${id} is not a live structural entity`);
    }
    return record;
  };
  return { schema, registry, read, meta, edges, refs, requireStructural };
}

/** Removal needs incoming references from every live entity; edits only read
 * their target and any explicitly validated relationship endpoints. */
export function structuralGraph(store: IfcDataStore, editor: StoreEditor): StructuralReader & { records: Map<number, StyleEntity> } {
  const reader = structuralReader(store, editor);
  const records = new Map<number, StyleEntity>();
  for (const { expressId } of iterateEffectiveEntityIds(store, editor.getMutationView())) {
    const record = reader.read(expressId);
    if (!record) throw new Error(`structural edit/remove: cannot inspect live entity #${expressId}`);
    records.set(expressId, record);
  }
  return { ...reader, records };
}
