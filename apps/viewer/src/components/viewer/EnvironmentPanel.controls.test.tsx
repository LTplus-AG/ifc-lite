/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5506 turned the floating `SunSkyPanel` into the docked `EnvironmentPanel`
 * side panel — a house-header + close-button restyle, no drag, no
 * self-owned open/collapse state. The controls inside must still drive the
 * exact same store values as before: this pins two of them (the sky/sun-time
 * standalone controls a model without Cesium relies on), so a restyle that
 * quietly detaches a control from its store setter fails here rather than
 * only in manual QA.
 */

import '@/test/setup-dom.js';
import { act } from 'react';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { EnvironmentPanel } from './EnvironmentPanel.js';

/** Change a `<select>`'s value the way a user does — through the native
 *  value setter, so React's tracker sees the change and fires `onChange`. */
function selectOption(el: HTMLSelectElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

/** Drag a `<input type="range">` to a value, same setter-then-event shape. */
function setRange(el: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  useViewerStore.setState({
    cesiumEnabled: false,
    cesiumAvailable: false,
    envPreset: 'default',
    envSunTimeEnabled: true,
    envSunTime: 13,
    envShadowsEnabled: false,
  });
});

afterEach(() => {
  cleanup();
  useViewerStore.setState({
    cesiumEnabled: false,
    cesiumAvailable: false,
    envPreset: 'default',
    envSunTimeEnabled: false,
    envSunTime: 13,
    envShadowsEnabled: false,
  });
});

describe('EnvironmentPanel controls drive the store (#5506 mutation check)', () => {
  it('the standalone environment/sky select still sets envPreset', () => {
    const container = render(<EnvironmentPanel />);
    const picker = container.querySelector<HTMLSelectElement>('select[aria-label="Environment preset"]');
    assert.ok(picker, 'expected the standalone environment preset select to render');
    selectOption(picker, 'golden');
    assert.strictEqual(useViewerStore.getState().envPreset, 'golden');
  });

  it('the manual time-of-day slider still sets envSunTime', () => {
    const container = render(<EnvironmentPanel />);
    const slider = container.querySelector<HTMLInputElement>('input[type="range"][aria-label="Sun time"]');
    assert.ok(slider, 'expected an accessible sun-time slider');
    setRange(slider, '9');
    assert.strictEqual(useViewerStore.getState().envSunTime, 9);
  });
});
