/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-class visibility toggles (`PointCloudClasses`, nested inside
 * `PointCloudPanel`) still drive `pointCloudClassMask` after the panel moved
 * from a floating card into the docked `pointclouds` side panel (#5507).
 * The move only touched the panel's outer chrome (header + close button,
 * `flex h-full flex-col` layout instead of an `absolute` card) — the
 * class-list control itself is untouched, so this pins that its store wiring
 * survived the restyle.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { isPointCloudClassVisible } from '@/store/slices/pointCloudSlice';
import { PointCloudPanel } from './PointCloudPanel';

const GROUND_CLASS_ID = 2; // ASPRS "Ground"

describe('PointCloudPanel — class-visibility toggles drive pointCloudClassMask (#5507)', () => {
  afterEach(() => {
    cleanup();
    useViewerStore.getState().setPointCloudClassCounts('asset-1', null);
    useViewerStore.getState().setPointCloudClassMask([0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF]);
  });

  it('unchecking a class hides it in the mask, rechecking restores it', () => {
    useViewerStore.getState().setPointCloudClassCounts('asset-1', { [GROUND_CLASS_ID]: 1234 });
    const container = render(<PointCloudPanel assetCount={1} triangleCount={0} />);

    // The class list is behind a <details> summary — open it.
    const details = container.querySelector('details');
    assert.ok(details, 'PointCloudClasses renders a <details> disclosure');
    act(() => { (details as HTMLDetailsElement).open = true; });

    const checkbox = container.querySelector<HTMLInputElement>(
      `input[type="checkbox"][aria-label*="Ground"]`,
    );
    assert.ok(checkbox, 'expected a checkbox for the Ground class');
    assert.equal(checkbox!.checked, true, 'starts visible (default mask)');
    assert.equal(isPointCloudClassVisible(useViewerStore.getState().pointCloudClassMask, GROUND_CLASS_ID), true);

    act(() => { checkbox!.click(); });
    assert.equal(
      isPointCloudClassVisible(useViewerStore.getState().pointCloudClassMask, GROUND_CLASS_ID),
      false,
      'unchecking the Ground class must clear its bit in pointCloudClassMask',
    );

    act(() => { checkbox!.click(); });
    assert.equal(
      isPointCloudClassVisible(useViewerStore.getState().pointCloudClassMask, GROUND_CLASS_ID),
      true,
      'rechecking must set the bit back',
    );
  });
});
