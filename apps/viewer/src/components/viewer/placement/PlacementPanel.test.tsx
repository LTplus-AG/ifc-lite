/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The docked `placement` panel's own shell (#5505): the Local / Georeference
 * tabs and the auto-follow that switches to whichever workflow just started.
 * `LocalTab.test.tsx` and `GeoreferenceTab.mapAbsolute.test.tsx` cover each
 * tab's own content; this file covers the shell that switches between them.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click, mouseDown } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { PlacementPanel } from './PlacementPanel';

const originalState = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(originalState, true); });

function tab(ui: HTMLElement, label: string): HTMLElement {
  const el = [...ui.querySelectorAll('[role="tab"]')].find((item) => item.textContent === label);
  assert.ok(el, `tab ${label}`); return el as HTMLElement;
}

describe('PlacementPanel (#5505)', () => {
  it('shows the Local tab by default with no active session', () => {
    useViewerStore.setState({ ...fixtureModels(fixtureModel('ifc')), modelPlacement: emptyPlacementState(), repositionOpen: false });
    const ui = render(<PlacementPanel />);
    assert.equal(tab(ui, 'Local').getAttribute('data-state'), 'active');
    assert.match(ui.textContent!, /No models selected/);
  });

  it('shows the Georeference tab\'s empty state when no georeferenced model is loaded', () => {
    useViewerStore.setState({ ...fixtureModels(fixtureModel('ifc')), modelPlacement: emptyPlacementState(), repositionOpen: false });
    const ui = render(<PlacementPanel />);
    mouseDown(tab(ui, 'Georeference'));
    assert.equal(tab(ui, 'Georeference').getAttribute('data-state'), 'active');
    assert.match(ui.textContent!, /No georeferenced model/);
  });

  it('follows the Local workflow to its tab once a reposition session opens', () => {
    useViewerStore.setState({ ...fixtureModels(fixtureModel('ifc')), modelPlacement: emptyPlacementState(), repositionOpen: false });
    const ui = render(<PlacementPanel />);
    mouseDown(tab(ui, 'Georeference'));
    assert.equal(tab(ui, 'Georeference').getAttribute('data-state'), 'active');
    act(() => useViewerStore.getState().openReposition(['ifc']));
    assert.equal(tab(ui, 'Local').getAttribute('data-state'), 'active');
  });

  it('#5811 gives the header close button an accessible name and closes on activation', () => {
    useViewerStore.setState({ ...fixtureModels(fixtureModel('ifc')), modelPlacement: emptyPlacementState(), repositionOpen: false });
    let closed = false;
    const ui = render(<PlacementPanel onClose={() => { closed = true; }} />);
    const closeButton = ui.querySelector('button[aria-label="Close placement panel"]');
    assert.ok(closeButton, 'expected a close button');
    assert.equal(closeButton.getAttribute('title'), null, 'tooltip text is separate from the accessible name');
    click(closeButton!);
    assert.equal(closed, true);
  });
});
