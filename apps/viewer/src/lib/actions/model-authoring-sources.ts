/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { ViewerState } from '@/store';
import type { ModelAuthoringPreview } from './model-authoring-preview';

interface Source { modelId: string; store: IfcDataStore | undefined; source: IfcDataStore['source'] | undefined; hash: string | undefined; view: MutablePropertyView | undefined; revision: number | undefined }
const sources = new WeakMap<ModelAuthoringPreview, Source[]>();
const needsSource = (preview: ModelAuthoringPreview) => preview.batch.operations.some(op =>
  op.op === 'grid.create' || op.op === 'column.createOnGrid' || op.op === 'material.layers' || op.op === 'element.replace' || op.op === 'element.align' || (op.op === 'element.rotate' && !!op.pivot) || op.op === 'element.copy' || op.op === 'element.array'
  || op.op === 'classification.add' || op.op === 'type.detach' || op.op === 'hosted.edit' || op.op === 'hosted.create' && 'params' in op || op.op === 'element.trimExtend'
  || op.op === 'element.split' || op.op.startsWith('stair.') || op.op.startsWith('railing.'));

/** Copy, split, Trim/Extend and hosted edit approval belong to these loaded sources, never to a later reload with matching names/ids. */
export function captureAuthoringSources(state: ViewerState, preview: ModelAuthoringPreview): void {
  if (!needsSource(preview)) return;
