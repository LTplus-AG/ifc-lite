/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IFC5_KNOWN_PROP_NAMES } from '@ifc-lite/export';
import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';

const SOURCE_SAMPLE = 50;

/**
 * Keep the dialog's bounded source sample while considering every pending
 * edit. An edited late row or an authored row can introduce the very property
 * for which the IFC5 filter is offered (#5249).
 */
export function hasFilterableIfc5Properties(store: IfcDataStore, view?: MutablePropertyView | null): boolean {
  const properties = view ?? store.properties;
  if (!properties) return false;

  // @raw-entity-enumeration-ok bounded parsed-source sample; the canonical iterator below applies tombstones and appends overlay creations
  const source = store.entities;
  const candidates = new Set<number>();
  for (let i = 0; i < Math.min(source.count, SOURCE_SAMPLE); i++) candidates.add(source.expressId[i]);
  for (const change of view?.getEffectiveChanges() ?? []) candidates.add(change.entityId);

  for (const { expressId } of iterateEffectiveEntityIds(store, view, undefined, candidates)) {
    for (const set of properties.getForEntity(expressId)) {
      for (const property of set.properties) {
        if (!IFC5_KNOWN_PROP_NAMES.has(property.name)) return true;
      }
    }
  }
  return false;
}
