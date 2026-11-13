/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { getFootprintRoofPlaneParts } from '@ifc-lite/create';
import type { PropertyValue } from '@ifc-lite/collab';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { pathForEntity } from '@/lib/collab/entity-paths.js';
import { roomPropertyApi } from '@/lib/collab/room-property-api.js';
import { roomSlotFor } from '@/lib/collab/room-model-target.js';
import type { ModelEditTarget, ModellingStore } from './mutation-modelling-records.js';

type Saved = { path: string; kind: 'quantity'; set: string; name: string; value: number | undefined }
  | { path: string; kind: 'property'; set: string; name: string; value: PropertyValue | undefined };

/** Publish canonical roof/plane measures in the body's existing room transaction. */
export function mirrorRoofMeasurements(store: ModellingStore, target: ModelEditTarget, roofId: number, view: MutablePropertyView): (() => void) | undefined {
  const state = store.getState(), session = state.collabSession;
  if (!session || !roomSlotFor(state, target.modelId)) return;
  const api = roomPropertyApi(), saved: Saved[] = [];
  const parts = getFootprintRoofPlaneParts(target.dataStore, view, roofId);
  const rollback = () => {
    for (const previous of [...saved].reverse()) {
      try {
        if (previous.kind === 'quantity') {
          if (previous.value === undefined) api.deleteQuantityValue(session.doc, previous.path, previous.set, previous.name);
          else api.setQuantityValue(session.doc, previous.path, previous.set, previous.name, previous.value);
        } else if (previous.value === undefined) api.deletePropertyValue(session.doc, previous.path, previous.set, previous.name);
        else api.setPropertyValue(session.doc, previous.path, previous.set, previous.name, previous.value);
      } catch (rollbackError) { console.warn('[roof] could not restore shared plane measurements', rollbackError); }
    }
  };
  try {
    for (const id of [roofId, ...parts]) {
      const path = pathForEntity(target.dataStore, id);
      if (!path) throw new Error(`Roof measurement entity #${id} has no room identity`);
      const set = id === roofId ? 'Qto_RoofBaseQuantities' : 'Qto_SlabBaseQuantities';
      const quantities = view.getQuantitiesForEntity(id).find(q => q.name === set)?.quantities;
      if (!quantities?.length) throw new Error(`Roof measurement entity #${id} has no ${set}`);
      for (const quantity of quantities) {
        saved.push({ path, kind: 'quantity', set, name: quantity.name, value: api.getQuantityValue(session.doc, path, set, quantity.name) });
        api.setQuantityValue(session.doc, path, set, quantity.name, quantity.value);
      }
      if (id === roofId) continue;
      const pitch = view.getForEntity(id).find(p => p.name === 'Pset_SlabCommon')?.properties.find(p => p.name === 'PitchAngle');
      if (typeof pitch?.value !== 'number' || !Number.isFinite(pitch.value)) throw new Error(`Roof plane #${id} has no finite pitch`);
      saved.push({ path, kind: 'property', set: 'Pset_SlabCommon', name: 'PitchAngle',
        value: structuredClone(api.getPropertyValue(session.doc, path, 'Pset_SlabCommon', 'PitchAngle')) });
      api.setPropertyValue(session.doc, path, 'Pset_SlabCommon', 'PitchAngle',
        { type: 'IfcPlaneAngleMeasure', value: pitch.value, source: 'derived' });
    }
  } catch (error) {
    rollback();
    throw error;
  }
  return rollback;
}
