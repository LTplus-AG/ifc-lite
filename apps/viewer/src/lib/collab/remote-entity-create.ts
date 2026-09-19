/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { StoreEditor, type MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { entityForPath, registerEntityPath } from './entity-paths';
import { applyRemoteAttribute } from './mutation-bridge';

export function createRemoteOverlayEntity(
  store: IfcDataStore,
  view: MutablePropertyView,
  entityPath: string,
  ifcClass: string,
  attributes: Readonly<Record<string, unknown>>,
): boolean {
  if (entityForPath(store, entityPath) !== null) return false;
  const created = new StoreEditor(store, view).addEntity(ifcClass, []);
  registerEntityPath(store, created.expressId, entityPath);
  for (const [name, value] of Object.entries(attributes)) {
    applyRemoteAttribute(view, store, created.expressId, name, value);
  }
  return true;
}
