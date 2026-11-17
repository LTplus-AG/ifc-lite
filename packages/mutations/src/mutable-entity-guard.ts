// SPDX-License-Identifier: MPL-2.0
/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { OverlaySnapshot } from './cooperative-overlay-access.js';
import { withoutEntityExposure } from './entity-read-barrier.js';
import { NewEntityMap } from './new-entity-map.js';
import { sameOverlayValue } from './overlay-value-equality.js';
import type { NewEntity } from './types.js';

/** Snapshot only records whose arrays escaped, including aliases obtained
 * during the callback. Ordinary read-only authoring never visits the prefix. */
export function guardMutableEntities(state: OverlaySnapshot) {
  const snapshots = new Map<NewEntityMap, Map<number, NewEntity>>();
  const stops: Array<() => void> = [];
  const dispose = () => { for (const stop of stops) stop(); };
  try {
    for (const map of Object.values(state)) {
      if (!(map instanceof NewEntityMap) || snapshots.has(map)) continue;
      const before = new Map<number, NewEntity>();
      snapshots.set(map, before);
      stops.push(map.watchAttributeExposure(id => {
        if (before.has(id)) return;
        const row = map.get(id);
        if (row) before.set(id, withoutEntityExposure(() => structuredClone(row)));
      }));
    }
  } catch (error) { dispose(); throw error; }
  return { dispose, validate() {
    withoutEntityExposure(() => {
      for (const [map, before] of snapshots) for (const [id, row] of before) {
        if (!sameOverlayValue(map.get(id), row)) throw new Error('The IFC overlay changed during a prepared transaction.');
      }
    });
  } };
}
