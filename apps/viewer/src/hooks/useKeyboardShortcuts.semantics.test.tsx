/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, press } from '@/test/render.js';
import { useViewerStore } from '@/store';
import {
  beginPlacement, commitPlacement, displayedTranslation, emptyPlacementState,
  previewPlacement, replayPlacement,
} from '@/lib/model-placement/state';
import { useKeyboardShortcuts } from './useKeyboardShortcuts.js';

const originalState = useViewerStore.getState();
const wall = { modelId: 'legacy', expressId: 7 };
const door = { modelId: 'legacy', expressId: 8 };
const windowRef = { modelId: 'legacy', expressId: 9 };

function Harness() {
  useKeyboardShortcuts();
  return null;
}

afterEach(() => {
  cleanup();
  useViewerStore.setState(originalState, true);
});

describe('shortcut meanings (#5855)', () => {
  it('= and + add the selection to an existing basket instead of replacing it', () => {
    const state = useViewerStore.getState();
    state.setBasket([wall]);
    state.addEntityToSelection(door);
    render(<Harness />);

    press(window, '=');
    assert.deepEqual(useViewerStore.getState().pinboardEntities, new Set(['legacy:7', 'legacy:8']));

    useViewerStore.getState().addEntityToSelection(windowRef);
    press(window, '+', { shiftKey: true });
    assert.deepEqual(useViewerStore.getState().pinboardEntities, new Set(['legacy:7', 'legacy:8', 'legacy:9']));
  });

  it('Ctrl+Y redoes the last undone workspace translation on non-Apple platforms', () => {
    const platform = Object.getOwnPropertyDescriptor(navigator, 'platform');
    const userAgentData = Object.getOwnPropertyDescriptor(navigator, 'userAgentData');
    Object.defineProperties(navigator, {
      platform: { configurable: true, value: 'Win32' },
      userAgentData: { configurable: true, value: { platform: 'Windows' } },
    });
    try {
      const move = previewPlacement(beginPlacement(emptyPlacementState(), ['ifc'], new Set(['ifc'])), [1, 2, 3]);
      const undone = replayPlacement(commitPlacement(move), 'undo');
      useViewerStore.setState({ modelPlacement: undone });
      render(<Harness />);

      press(window, 'y', { ctrlKey: true });
      assert.deepEqual(displayedTranslation(useViewerStore.getState().modelPlacement, 'ifc'), [1, 2, 3]);
    } finally {
      if (platform) Object.defineProperty(navigator, 'platform', platform);
      else Reflect.deleteProperty(navigator, 'platform');
      if (userAgentData) Object.defineProperty(navigator, 'userAgentData', userAgentData);
      else Reflect.deleteProperty(navigator, 'userAgentData');
    }
  });
});
