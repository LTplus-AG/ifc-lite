/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6720: skipping the welcome tour's "Load a model" with nothing open makes
 * the next steps load the demo project. The Skip button says so while that
 * is what it will do, and only then.
 */

import '@/test/setup-dom.js';
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { getTour } from '@/lib/tours/registry';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { TourStepCard } from './TourStepCard.js';

const originalState = useViewerStore.getState();
after(() => { useViewerStore.setState(originalState, true); });
afterEach(() => {
  cleanup();
  useViewerStore.setState(originalState, true);
});

const buttons = (root: HTMLElement) => [...root.querySelectorAll('button')].map((b) => b.textContent ?? '');

describe('welcome tour load step Skip label (#6720)', () => {
  it('reads "Skip (use demo)" on an empty viewer, and plain "Skip step" once a model is there', () => {
    useViewerStore.setState({ models: new Map(), ifcDataStore: null, loading: false });
    const tour = getTour('welcome')!;
    const load = tour.steps.find((s) => s.id === 'load')!;
    const root = render(<TourStepCard tour={tour} step={load} stepIndex={0} targetEl={null} />);
    assert.ok(buttons(root).includes('Skip (use demo)'));
    act(() => { useViewerStore.setState({ ...fixtureModels(fixtureModel('m')) }); });
    assert.ok(buttons(root).includes('Skip step'));
    assert.ok(!buttons(root).includes('Skip (use demo)'));
  });

  it('a legacy single-model store counts as loaded (one definition of "empty" with the tour and the panels)', () => {
    useViewerStore.setState({ models: new Map(), ifcDataStore: fixtureModel('legacy').ifcDataStore, loading: false });
    const tour = getTour('welcome')!;
    const load = tour.steps.find((s) => s.id === 'load')!;
    const root = render(<TourStepCard tour={tour} step={load} stepIndex={0} targetEl={null} />);
    assert.ok(buttons(root).includes('Skip step'));
  });

  it('never relabels a step that does not load the demo when skipped', () => {
    useViewerStore.setState({ models: new Map(), ifcDataStore: null, loading: false });
    const tour = getTour('welcome')!;
    const orbit = tour.steps.find((s) => s.id === 'orbit')!;
    const root = render(<TourStepCard tour={tour} step={orbit} stepIndex={1} targetEl={null} />);
    assert.ok(!buttons(root).includes('Skip (use demo)'));
  });
});
