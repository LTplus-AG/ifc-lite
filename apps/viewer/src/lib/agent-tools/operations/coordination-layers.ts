/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { computeLayerContribution } from '@/lib/layers/stack';
import { emptySchema } from './contract';
import { coordination, idSchema } from './coordination-common';
export const coordinationLayerOperations = [
  coordination('layers.read', 'Read ordered IFCX composition layers and provenance without copying source documents.', ['read'], emptySchema, () => {
    const s = useViewerStore.getState(); return { layers: s.layerStack.map(({ file: _file, ...entry }) => entry), diff: s.layerStackDiff, busy: s.layerDiffBusy };
  }),
  coordination('layers.contribution', 'Compute a layer contribution using the native IFCX stack diff service. Rejects a replaced composition; returns the actual diff.', ['read'], idSchema, async (i, c) => {
    const s = useViewerStore.getState(), stack = s.layerStack;
    if (!stack.some(layer => layer.id === i.id)) throw new Error('Unknown loaded layer.');
    c.checkpoint?.(); const diff = await computeLayerContribution(stack, i.id); c.checkpoint?.();
    if (useViewerStore.getState().layerStack !== stack) throw new Error('Layer composition changed during analysis.');
    return { layer_id: i.id, diff };
  }),
];
