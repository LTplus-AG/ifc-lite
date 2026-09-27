/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, press, render } from '@/test/render.js';
import { registerKeyboardCommand } from '@/lib/commands/dispatcher';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { useViewerStore } from '@/store';
import { RepositionRuntimeHost } from './RepositionRuntimeHost.js';

let initialState: ReturnType<typeof useViewerStore.getState>;
before(() => { initialState = useViewerStore.getState(); });
afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState, true);
});

it('Escape cancels only Reposition and preserves the entity selection (#5847)', () => {
  useViewerStore.setState({
    repositionOpen: true,
    modelPlacement: emptyPlacementState(),
    selectedEntityId: 42,
    selectedEntityIds: new Set([42]),
  });
  let globalEscapes = 0;
  const removeGlobal = registerKeyboardCommand('selection.escape', () => { globalEscapes++; });
  try {
    render(<RepositionRuntimeHost />);
    assert.equal(useViewerStore.getState().repositionOpen, true);
    press(document.body, 'Escape');
    const state = useViewerStore.getState();
    assert.equal(state.repositionOpen, false, 'the active Reposition session is cancelled');
    assert.equal(globalEscapes, 0, 'the global Escape action does not run');
    assert.equal(state.selectedEntityId, 42);
    assert.deepEqual([...state.selectedEntityIds], [42]);
  } finally {
    removeGlobal();
  }
});
