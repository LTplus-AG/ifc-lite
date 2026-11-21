/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The test-only snap probe (#10264) must see what the viewport shows. Since type visibility hides ids on the GPU
 * (#10867), type-hidden meshes (spaces, openings) are uploaded and only the viewport's derived hidden set keeps
 * picks off them; a probe without it hits invisible openings in front of the surfaces the release spec measures.
 */

import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { StoreApi } from 'zustand';
import type { Renderer } from '@ifc-lite/renderer';
import { geometryBackingCommand } from './backing-debug-hook';

it('the snap probe raycasts under the viewport visibility it is given (type-hidden ids included)', async () => {
  const seen: Array<{ hiddenIds?: ReadonlySet<number>; isolatedIds?: ReadonlySet<number> | null }> = [];
  const renderer = {
    getScene: () => ({ isGeometryDataReleased: () => false, isInstancedEntity: () => false }),
    raycastSceneMagnetic: (_x: number, _y: number, _lock: unknown, options: { hiddenIds?: ReadonlySet<number>; isolatedIds?: ReadonlySet<number> | null }) => {
      seen.push(options);
      return { intersection: null, snapTarget: null };
    },
  } as unknown as Renderer;
  const hidden = new Set([7]), isolated = new Set([3, 7]);
  const rows = await geometryBackingCommand({} as StoreApi<never>, renderer, { action: 'snap-probe-for-test', points: [[10, 20]] },
    () => ({ hiddenIds: hidden, isolatedIds: isolated }));
  assert.equal(rows.length, 1);
  assert.equal(seen[0].hiddenIds, hidden, 'the viewport hidden set, type-hidden ids included');
  assert.equal(seen[0].isolatedIds, isolated);
});
