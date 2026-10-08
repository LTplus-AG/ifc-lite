/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { ViewerState } from '../index.js';
import { splitInViewer } from './mutation-split.js';
import type { ModellingStore } from './mutation-modelling-records.js';
export { emitClippedProfile } from '../../../../../packages/create/src/in-store/element-split-slab.js';

export function splitSlab(
  get: () => ViewerState, editorFor: (id: string) => StoreEditor | null,
  modelId: string, expressId: number, cutA: [number, number], cutB: [number, number], store: ModellingStore,
) {
  return splitInViewer(get, editorFor, modelId, expressId, { kind: 'slab', a: cutA, b: cutB }, store);
}
