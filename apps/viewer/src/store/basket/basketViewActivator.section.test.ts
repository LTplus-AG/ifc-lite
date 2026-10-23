/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A basket view keeps every plane that was cutting (#7545), and activating one puts the
 * whole set back; a view saved with no cut turns EVERY plane off, not just the active one.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '../index.js';
import { orderedSectionPlanes } from '@/lib/section/section-plane-set';
import { activateBasketViewFromStore } from './basketViewActivator.js';

const state = () => useViewerStore.getState();
const summary = () => orderedSectionPlanes(state().sectionPlane, state().inactiveSectionPlanes)
  .map((p) => ({ name: p.name, axis: p.axis, position: p.position, flipped: p.flipped, enabled: p.enabled }));

beforeEach(() => {
  state().resetViewerState();
  useViewerStore.setState({ cameraCallbacks: {} });
  state().addToBasket?.([{ modelId: 'm', expressId: 1 }]);
});

function threeCuts() {
  state().setActiveTool('section');
  state().addSectionPlane('down'); state().setSectionPlanePosition(40);
  state().addSectionPlane('front'); state().setSectionPlanePosition(60); state().flipSectionPlane();
  state().addSectionPlane('side'); state().setSectionPlanePosition(25);
}

describe('basket views and several cutting planes (#7545)', () => {
  it('restores every plane that was cutting, with the active one active', () => {
    threeCuts();
    const before = summary();
    state().pinboardEntities.size === 0 && useViewerStore.setState({ pinboardEntities: new Set(['m:1']) });
    const id = state().saveCurrentBasketView({ name: 'Three cuts' });
    assert.ok(id, 'the view was saved');
    assert.equal(state().basketViews[0]!.section?.planes?.length, 3, 'all three cutting planes are in the snapshot');

    state().clearSectionPlanes();
    state().addSectionPlane('front');
    state().setSectionPlanePosition(90);
    state().setActiveTool('select');

    activateBasketViewFromStore(id!);
    assert.deepEqual(summary(), before);
    assert.equal(state().sectionPlane.axis, 'side', 'the plane that was active is active again');
    assert.equal(state().activeTool, 'section');
    assert.equal(state().sceneState.section.visible, true);
  });

  it('a view saved with no cut turns every plane off, not only the active one', () => {
    useViewerStore.setState({ pinboardEntities: new Set(['m:1']) });
    const id = state().saveCurrentBasketView({ name: 'No cut' });
    assert.equal(state().basketViews[0]!.section, null);
    threeCuts();
    assert.ok(summary().filter((p) => p.enabled).length === 3);

    activateBasketViewFromStore(id!);
    assert.deepEqual(summary().filter((p) => p.enabled), [], 'no plane keeps cutting');
    assert.equal(state().activeTool, 'select');
  });
});
