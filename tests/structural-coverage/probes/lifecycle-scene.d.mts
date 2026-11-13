/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type * as create from '../../../packages/create/src/index.js';
import type * as parser from '@ifc-lite/parser';
import type * as mutations from '@ifc-lite/mutations';
import type * as exporter from '@ifc-lite/export';
export function lifecycleScene(pkgs: { create: typeof create; parser: typeof parser; mutations: typeof mutations; exporter: typeof exporter }, schema: string, stepId: string): Promise<{
  store: parser.IfcDataStore;
  view: mutations.MutablePropertyView;
  editor: mutations.StoreEditor;
  anchor: create.SpatialAnchor;
  id: number;
  exportText(): string;
  before: { entities: Map<number, unknown> };
}>;
