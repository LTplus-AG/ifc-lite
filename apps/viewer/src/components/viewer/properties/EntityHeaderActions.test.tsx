/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #3618: from an Entity List row a user can select an object and reach the
 * Properties panel's "info tab", but the existing "Zoom to" button does not
 * help when the object sits behind other geometry, and full Isolate ("I")
 * hides everything else and loses spatial context. "Show in context" reuses
 * the already-shared X-Ray channel (`ghostExceptEntities`, driven by Clash,
 * IDS and BCF) so the rest of the model fades translucent instead of
 * disappearing, and frames the camera on the selected entity in the same
 * click.
 *
 * Driven through the REAL `EntityHeaderActions` component and the real store,
 * never by calling `setGhostExceptEntities` directly — the defect class this
 * repo keeps re-finding is a handler wired to the wrong id or channel.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { EntityHeaderActions } from './EntityHeaderActions.js';

const SELECTED = 4_000_042;
const OTHER = 4_000_099;

function resetStore(): void {
  useViewerStore.setState({
    selectedEntityId: null,
    ghostExceptEntities: null,
    isolatedEntities: null,
    hiddenEntities: new Set<number>(),
    cameraCallbacks: {},
  });
}

describe('EntityHeaderActions — "Show in context"', () => {
  afterEach(() => {
    cleanup();
    resetStore();
  });

  it('ghosts every other entity and frames the camera, without isolating (hiding) anything', () => {
    let framed = 0;
    resetStore();
    useViewerStore.setState({
      selectedEntityId: SELECTED,
      cameraCallbacks: { frameSelection: () => { framed += 1; } },
    });

    const container = render(<EntityHeaderActions />);
    const ghostButton = Array.from(container.querySelectorAll('button'))[1];
    assert.ok(ghostButton, 'expected three header buttons (Zoom to, Show in context, Hide/Show)');

    click(ghostButton);

    const state = useViewerStore.getState();
    assert.deepStrictEqual(
      state.ghostExceptEntities && Array.from(state.ghostExceptEntities),
      [SELECTED],
      'ghostExceptEntities must hold exactly the selected entity',
    );
    assert.strictEqual(state.isolatedEntities, null, 'ghosting must not also isolate (hide) the rest');
    assert.strictEqual(framed, 1, 'the camera must frame the selected entity in the same click');
  });

  it('toggles off on a second click, clearing the ghost channel', () => {
    resetStore();
    useViewerStore.setState({
      selectedEntityId: SELECTED,
      ghostExceptEntities: new Set([SELECTED]),
      cameraCallbacks: {},
    });

    const container = render(<EntityHeaderActions />);
    const ghostButton = Array.from(container.querySelectorAll('button'))[1];

    click(ghostButton);

    assert.strictEqual(useViewerStore.getState().ghostExceptEntities, null);
  });

  it('does not clear a ghost context installed for a DIFFERENT entity — clicking sets its own', () => {
    resetStore();
    useViewerStore.setState({
      selectedEntityId: SELECTED,
      ghostExceptEntities: new Set([OTHER]),
      cameraCallbacks: {},
    });

    const container = render(<EntityHeaderActions />);
    const ghostButton = Array.from(container.querySelectorAll('button'))[1];

    click(ghostButton);

    assert.deepStrictEqual(
      Array.from(useViewerStore.getState().ghostExceptEntities ?? []),
      [SELECTED],
      'a click for the selected entity must replace the previous ghost set with its own',
    );
  });

  it('control: "Zoom to" and "Hide" keep their existing, unrelated behaviour', () => {
    let framed = 0;
    resetStore();
    useViewerStore.setState({
      selectedEntityId: SELECTED,
      cameraCallbacks: { frameSelection: () => { framed += 1; } },
    });

    const container = render(<EntityHeaderActions />);
    const buttons = Array.from(container.querySelectorAll('button'));
    const [zoomButton, , hideButton] = buttons;

    click(zoomButton);
    assert.strictEqual(framed, 1);
    assert.strictEqual(useViewerStore.getState().ghostExceptEntities, null, 'Zoom to must not touch ghosting');

    click(hideButton);
    assert.ok(
      useViewerStore.getState().hiddenEntities.has(SELECTED),
      'Hide must still hide the selected entity, unchanged by the new button',
    );
  });
});
