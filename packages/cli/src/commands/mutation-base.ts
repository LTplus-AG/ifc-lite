/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { MutablePropertyView } from '@ifc-lite/mutations';
import { configureSourceMutationView } from '@ifc-lite/sdk/headless';
import type { IfcDataStore } from '@ifc-lite/parser';

export function createSourceMutationView(store: IfcDataStore): MutablePropertyView {
  const view = new MutablePropertyView(null, 'default');
  configureSourceMutationView(store, view);
  return view;
}
