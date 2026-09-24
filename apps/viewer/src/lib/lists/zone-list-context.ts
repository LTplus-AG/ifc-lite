/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ZoneSet, ZoneAssignmentsByElement, ZoneApportionmentCache } from '../zones/index.js';

/** Per-model zone and world-coordinate context, keyed through federated IDs. */
export interface ZoneListContext {
  zoneSets: ZoneSet[];
  zoneAssignments: ZoneAssignmentsByElement;
  /** Read through validEntry, so a result computed before zones moved is not served. */
  apportionment?: ZoneApportionmentCache;
  /** Scale from this model's volume unit to SI for zone volume columns. */
  volumeSiScale?: number;
  /** World coordinate in this model's own unit. */
  getWorldPosition?: (expressId: number) => { x: number; y: number; z: number } | null;
  /** Single-model fallback maps an id to itself. */
  toGlobalId: (expressId: number) => number;
}
