/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Renderer } from '@ifc-lite/renderer';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { handleSelectionClick } from './selectionHandlers.js';
import { registerViewportFacePicker } from './appearance/face-mask/viewport-face-picker.js';

test('appearance face clicks use the exact visible hit and leave ordinary selection untouched (#4555)', async () => {
  const picked: number[] = [];
  const release = registerViewportFacePicker({ globalId: 1_025, modelIndex: 1,
    geometryItemIds: new Set([1_101]), triangleCount: 20, canPick: () => true, onToggle: value => picked.push(value) });
  let ordinarySelections = 0;
  const renderer = { raycastScene: (_x: number, _y: number, options: { hiddenIds: Set<number>; isolatedIds: Set<number> | null }) => {
    assert.deepEqual([...options.hiddenIds], [99]); assert.deepEqual([...(options.isolatedIds ?? [])], [1_025]);
    return { intersection: { point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, distance: 1,
      meshIndex: 0, triangleIndex: 0, expressId: 1_025, modelIndex: 1, geometryItemId: 1_101,
      sourceTriangleIndex: 13, barycentricCoord: { u: 0.2, v: 0.3, w: 0.5 } } };
  } } as unknown as Renderer;
  const ctx = { canvas: { getBoundingClientRect: () => ({ left: 4, top: 5 }) }, renderer,
    mouseState: { didDrag: false }, activeToolRef: { current: 'appearance-face' },
    hiddenEntitiesRef: { current: new Set([99]) }, isolatedEntitiesRef: { current: new Set([1_025]) },
    getPickOptions: () => ({ isStreaming: false, hiddenIds: new Set([99]), isolatedIds: new Set([1_025]) }),
    handlePickForSelection: () => ordinarySelections++, toggleSelection: () => ordinarySelections++,
  } as unknown as MouseHandlerContext;
  await handleSelectionClick(ctx, { clientX: 14, clientY: 25 } as MouseEvent);
  assert.deepEqual(picked, [13]);
  assert.equal(ordinarySelections, 0);
  release();
});
