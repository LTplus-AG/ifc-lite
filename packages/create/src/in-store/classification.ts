/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { IfcDataStore } from '@ifc-lite/parser';
import type { StoreEditor } from '@ifc-lite/mutations';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { AnchorEntityReader } from './resolve-anchor.js';
import { resolveAuthoringAnchor } from './resolve-relations.js';
import { schemaAttributes, schemaRegistry } from './schema-attributes.js';
import { ownerHistoryRef } from './_emit-helpers.js';
import { liveEntityConforms } from './resolve-relations.js';
import { refId } from './host-geometry-frame.js';

export interface ClassificationInStoreParams {
  /** Classification system's IfcClassification.Name. */
  System: string;
  Identification: string;
  Name?: string;
  Source?: string;
  Edition?: string;
  Location?: string;
  objects?: readonly number[];
}

/** Reuse a live system and reference, then optionally associate occurrences.
 * Multiple classifications per object are valid: assigning one never removes another. */
export function addClassificationInStore(store: IfcDataStore, editor: StoreEditor, params: ClassificationInStoreParams): number {
  if (!params.System.trim() || !params.Identification.trim()) throw new Error('Classification System and Identification must not be empty');
  return editor.runAtomic(draft => {
    const view = draft.getMutationView(), reader = new AnchorEntityReader(store, view);
    const anchor = resolveAuthoringAnchor(store, view), registry = schemaRegistry(anchor.schema, 'addClassification');
    const emit = (type: string, values: Record<string, unknown>) => draft.addEntity(type,
      schemaAttributes(registry, type, values, 'addClassification') as Parameters<StoreEditor['addEntity']>[1]).expressId;
    let system = [...reader.ids('IFCCLASSIFICATION')].find(id => {
      const e = reader.entity(id)!;
      return e.attributes[e.names.indexOf('Name')] === params.System
        && (e.attributes[e.names.indexOf('Edition')] ?? undefined) === params.Edition;
    });
    system ??= emit('IfcClassification', { Source: params.Source, Edition: params.Edition, Name: params.System });
    let reference = [...reader.ids('IFCCLASSIFICATIONREFERENCE')].find(id => {
      const e = reader.entity(id)!;
      return refId(e.attributes[e.names.indexOf('ReferencedSource')]) === system
        && e.attributes[e.names.indexOf(registry.name.toUpperCase() === 'IFC2X3' ? 'ItemReference' : 'Identification')] === params.Identification;
    });
    reference ??= emit('IfcClassificationReference', {
      Location: params.Location, [registry.name.toUpperCase() === 'IFC2X3' ? 'ItemReference' : 'Identification']: params.Identification,
      Name: params.Name, ReferencedSource: `#${system}`,
    });
    if (params.objects?.length) assignClassificationInStore(store, draft, reference, params.objects);
    return reference;
  });
}

export function assignClassificationInStore(store: IfcDataStore, editor: StoreEditor, classificationId: number, objects: readonly number[]): number {
  return editor.runAtomic(draft => {
    const view = draft.getMutationView(), reader = new AnchorEntityReader(store, view);
    if (!liveEntityConforms(store, classificationId, 'IfcClassificationReference', view)
      && !liveEntityConforms(store, classificationId, 'IfcClassification', view)) throw new Error('Expected a live classification or reference');
    const ids = [...new Set(objects)];
    if (!ids.length || ids.some(id => !liveEntityConforms(store, id, 'IfcObjectDefinition', view))) throw new Error('Classification requires live object definitions');
    for (const rel of reader.ids('IFCRELASSOCIATESCLASSIFICATION')) {
      const e = reader.entity(rel)!;
      if (refId(e.attributes[5]) !== classificationId) continue;
      const old = Array.isArray(e.attributes[4]) ? e.attributes[4].map(refId).filter((id): id is number => id !== null) : [];
      draft.setPositionalAttribute(rel, 4, [...new Set([...old, ...ids])].map(id => `#${id}`));
      return rel;
    }
    const anchor = resolveAuthoringAnchor(store, view), registry = schemaRegistry(anchor.schema, 'assignClassification');
    return draft.addEntity('IfcRelAssociatesClassification', schemaAttributes(registry, 'IfcRelAssociatesClassification', {
      GlobalId: generateIfcGuid(anchor.guidRandom), OwnerHistory: ownerHistoryRef(anchor.ownerHistoryId),
      RelatedObjects: ids.map(id => `#${id}`), RelatingClassification: `#${classificationId}`,
    }, 'assignClassification') as Parameters<StoreEditor['addEntity']>[1]).expressId;
  });
}
