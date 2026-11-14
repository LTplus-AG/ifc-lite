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
import { cleanup, click, render, type as typeInto } from '@/test/render.js';
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
  spaceMouseConnect: null,
  spaceMouseUseDriver: false,
  spaceMouseDriverStatus: 'off' as const,
  spaceMouseDriverError: null,
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

describe('SpaceMousePanel — "Use the 3Dconnexion driver" (#9131)', () => {
  it('the switch is off by default, shows without WebHID, and turning it on writes the store', () => {
    // Firefox/Safari case: no WebHID, but the driver path still applies.
    useViewerStore.setState({ spaceMouseSupported: false });
    const container = render(<SpaceMousePanel />);
    const toggle = container.querySelector('button[role="switch"]');
    assert.ok(toggle, 'expected the driver switch to render');
    assert.equal(toggle!.getAttribute('aria-checked'), 'false');
    click(toggle!);
    assert.equal(useViewerStore.getState().spaceMouseUseDriver, true);
  });

  it('while the driver is connected the WebHID controls are hidden; when it is unavailable they stay', () => {
    useViewerStore.setState({
      spaceMouseSupported: true,
      spaceMouseConnect: () => {},
      spaceMouseUseDriver: true,
      spaceMouseDriverStatus: 'connected',
    });
    const container = render(<SpaceMousePanel />);
    // A boolean, not the element: a failing assert.equal(element, null) makes the test reporter serialise the live
    // DOM node (and the window behind it), which hangs the file until the test timeout instead of failing.
    assert.ok(!container.querySelector('input[type="range"]'), 'sensitivity does not apply to the driver');
    assert.match(container.textContent ?? '', /Connected through the 3Dconnexion driver/);
    cleanup();

    useViewerStore.setState({ spaceMouseDriverStatus: 'unavailable', spaceMouseDriverError: 'driver not reachable' });
    const fallback = render(<SpaceMousePanel />);
    assert.ok(fallback.querySelector('input[type="range"]'), 'WebHID stays in use when the driver is unavailable');
    assert.ok(fallback.querySelector('[title="driver not reachable"]'), 'the reason is kept as a tooltip');
  });
});
