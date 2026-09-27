/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Behavioural coverage for the SpaceMouse settings moved into Preferences →
 * Navigation (#5509). `MiscPanelsA.i18n.test.tsx` covers translation; this
 * covers the one piece of real behaviour a settings control has to get
 * right — dragging the sensitivity slider writes the same store value the
 * old floating panel did (`setSpaceMouseSensitivity`), so
 * `useSpaceMouseControls` (which reads `spaceMouseSensitivity` to drive the
 * camera) keeps working unchanged.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render, type as typeInto } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { SENSITIVITY } from '@/lib/spacemouse/constants';
import { SpaceMousePanel } from './SpaceMousePanel.js';

const RESET_STATE = {
  spaceMouseSupported: false,
  spaceMouseConnected: false,
  spaceMouseDeviceName: null,
  spaceMouseError: null,
  spaceMouseSensitivity: SENSITIVITY.default,
  spaceMouseGetDiagnostics: null,
};

beforeEach(() => {
  useViewerStore.setState(RESET_STATE);
});

afterEach(() => {
  cleanup();
  useViewerStore.setState(RESET_STATE);
});

describe('SpaceMousePanel — sensitivity slider (#5509)', () => {
  it('moving the slider writes spaceMouseSensitivity in the store', () => {
    useViewerStore.setState({ spaceMouseSupported: true, spaceMouseConnected: false });
    const container = render(<SpaceMousePanel />);

    const slider = container.querySelector('input[type="range"]') as HTMLInputElement | null;
    assert.ok(slider, 'expected the sensitivity range input to render');

    const target = Math.min(SENSITIVITY.max, SENSITIVITY.default + SENSITIVITY.step * 2);
    assert.notEqual(target, useViewerStore.getState().spaceMouseSensitivity);

    typeInto(slider!, String(target));

    assert.equal(useViewerStore.getState().spaceMouseSensitivity, target);
  });
});
