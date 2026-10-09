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
  op.op === 'curtainWall.create' || op.op === 'material.layers' || op.op === 'element.reassignStorey' || op.op === 'grid.create' || op.op === 'column.createOnGrid' || op.op === 'element.replace' || op.op === 'element.align' || (op.op === 'element.rotate' && !!op.pivot) || op.op === 'element.copy' || op.op === 'element.array'
