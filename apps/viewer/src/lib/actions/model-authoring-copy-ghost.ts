/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import { copiedProductsInStore, createCopyContext, productStoreyOrigin } from '@ifc-lite/create';
import type { ViewerState } from '@/store';
import { copyGhosts, sourceMeshes } from '@/lib/commands/modeling/copy-ghost';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import type { ModelAuthoringBatch } from './model-authoring';
import type { AuthoringRow } from './model-authoring-preview';
import { authoringReader } from './model-authoring-read';
import { authoringCopyTransforms } from './model-authoring-copy';

/** The exact native copy ghost map, with ids owned by the proposal channel. */
export function authoringCopyGhosts(state: ViewerState, batch: ModelAuthoringBatch, row: AuthoringRow, ghostId: number): MeshData[] {
  if (row.op.op !== 'element.copy' && row.op.op !== 'element.array') return [];
  const target = row.resolved.subject;
  const reader = row.modelId ? authoringReader(state, row.modelId) : null;
  // Earlier draft creations have no published meshes; their review explicitly says so.
  if (!target || !('id' in target) || !reader) return [];
  const ctx = createCopyContext(reader.dataStore, reader.editor);
  const source = productStoreyOrigin(ctx, target.id);
  if (!source || source.storeyId === null) return [];
  const from = buildStoreyWorkplane(state, reader.modelId, source.storeyId, 0);
  const to = buildStoreyWorkplane(state, reader.modelId, row.resolved.storey ?? source.storeyId, 0);
  if (!isWorkplane(from) || !isWorkplane(to)) return [];
  const meshes = sourceMeshes(state, reader.modelId, copiedProductsInStore(ctx, [target.id]));
  return copyGhosts(state, meshes, from, to, authoringCopyTransforms(batch, row.op, row.resolved.storey)).map(mesh => ({ ...mesh, expressId: ghostId }));
}
