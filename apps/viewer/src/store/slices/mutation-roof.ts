/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Edit a roof by footprint (#9296 round 3) as one undo step: the shared create
 * core rebuilds its planes inside `recordModellingEdit`'s atomic commit, so a
 * refusal writes nothing and `Ctrl+Z` restores the previous planes whole. In a
 * shared room the recorded definition is published with the body.
 */

import { refreshTopAttachmentsInStore, editFootprintRoofInStore, footprintDefinitionProperties, ROOF_FOOTPRINT_PSET, type RoofFootprintEdit, type FootprintRoofDefinition } from '@ifc-lite/create';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { PropertyValue } from '@ifc-lite/collab';
import { roomPropertyApi } from '@/lib/collab/room-property-api.js';
import { pathForEntity } from '@/lib/collab/entity-paths.js';
import { roomSlotFor } from '@/lib/collab/room-model-target.js';
import { mutationDenial } from '../mutation-permission.js';
import { modelEditTarget, recordModellingEdit, type ModelEditTarget, type ModellingStore } from './mutation-modelling-records.js';

export type RoofEditOutcome = { readonly ok: true; readonly remesh: number[] } | { readonly ok: false; readonly reason: string };
type RoofDefinition = FootprintRoofDefinition | ReturnType<MutablePropertyView['getForEntity']>[number]['properties'];

export function editRoofIn(store: ModellingStore, modelId: string, expressId: number, patch: RoofFootprintEdit): RoofEditOutcome {
  const refusal = mutationDenial(store.getState(), modelId);
  if (refusal) return { ok: false, reason: refusal };
  const target = modelEditTarget(store.getState(), modelId);
  if (!target) return { ok: false, reason: `No model loaded for id "${modelId}"` };
  try {
    const remesh = withRoofDefinitionRollback(store, target, expressId, publish => recordModellingEdit(store, modelId, (_methods, draft) => {
      const definition = editFootprintRoofInStore(target.dataStore, draft, expressId, patch);
      const attached = refreshTopAttachmentsInStore({ ...target, editor: draft, view: draft.getMutationView() }, [expressId]);
      publish(definition);
      return [expressId, ...attached];
    }));
    return { ok: true, remesh };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Yjs does not roll back on throw: restore definition values before peers observe the transaction. */
function withRoofDefinitionRollback<T>(store: ModellingStore, target: ModelEditTarget, id: number,
  edit: (publish: (definition: RoofDefinition) => void) => T): T {
  const state = store.getState();
  const session = roomSlotFor(state, target.modelId) ? state.collabSession : null;
  const path = session ? pathForEntity(target.dataStore, id) : null;
  if (session && !path) throw new Error(`Roof #${id} has no collaboration room identity`);
  const room = session && path ? { session, path } : null;
  const api = room ? roomPropertyApi() : null;
  const before = new Map<string, PropertyValue | undefined>();
  const publish = (definition: RoofDefinition) => {
    // Edits return the definition; creation already recorded it in its draft.
    const properties = 'Footprint' in definition ? footprintDefinitionProperties(definition)
      : definition.map(property => [property.name, property.value, property.type] as const);
    for (const [name, value, type] of properties) {
      if (room && api && !before.has(name)) before.set(name, structuredClone(api.getPropertyValue(room.session.doc, room.path, ROOF_FOOTPRINT_PSET, name)));
      store.getState().mirrorPropertyEdit(target.modelId, id, ROOF_FOOTPRINT_PSET, name, value, type);
    }
  };
  if (!room || !api) return edit(publish);
  return room.session.transact(() => {
    try { return edit(publish); }
    catch (error) {
      for (const [name, value] of before) {
        if (value === undefined) api.deletePropertyValue(room.session.doc, room.path, ROOF_FOOTPRINT_PSET, name);
        else api.setPropertyValue(room.session.doc, room.path, ROOF_FOOTPRINT_PSET, name, value);
      }
      // A refused draft is unchanged locally and in the room. Surface the
      // publication failure through the layout's existing notice channel.
      if (before.size > 0) store.setState({ collabGeometryNotice:
        `Roof #${id} was not changed because it could not be shared with room "${room.session.roomId}". The previous shared roof was restored.` });
      throw error;
    }
  });
}

/** New roofs use the same definition as edits, on both the SDK and Model tool paths. */
export function mirrorNewRoofDefinition(store: ModellingStore, modelId: string, id: number, view: MutablePropertyView): void {
  const definition = view.getForEntity(id).find(pset => pset.name === ROOF_FOOTPRINT_PSET);
  if (!definition) return;
  const target = modelEditTarget(store.getState(), modelId);
  if (!target) throw new Error(`No model loaded for id "${modelId}"`);
  withRoofDefinitionRollback(store, target, id, publish => publish(definition.properties));
}
