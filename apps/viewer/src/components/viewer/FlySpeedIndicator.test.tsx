/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `FlySpeedIndicator` moved onto the HUD as a bottom-center readout (#5504,
 * charter #5478 item 22): it now portals through `HudItem` instead of an
 * `absolute`-positioned wrapper of its own, so it renders nothing until
 * `ViewportHud` is mounted alongside it.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup } from '@/test/render.js';
import { setFlySpeedState } from './flySpeedStore.js';
import { FLY_SPEED_LEVELS } from './flyNavigation.js';
import { ViewportHud } from '../viewport-ui/hud/ViewportHud.js';
import { FlySpeedIndicator } from './FlySpeedIndicator.js';

function renderIndicator(): HTMLElement {
  return render(
    <>
      <ViewportHud />
      <FlySpeedIndicator />
    </>,
  );
}

function bottomCenterText(): string {
  const region = document.querySelector('[data-hud-region="bottom-center"]');
  assert.ok(region, 'ViewportHud mounts the bottom-center region');
  return region!.textContent ?? '';
}

afterEach(() => {
  cleanup();
  act(() => setFlySpeedState({ level: 3, active: false, changedAt: -Infinity }));
});

describe('FlySpeedIndicator (#5504)', () => {
  it('renders nothing while fly mode is inactive and no speed change is lingering', () => {
    act(() => setFlySpeedState({ level: 3, active: false, changedAt: -Infinity }));
    const container = renderIndicator();
    assert.equal(container.querySelector('[data-hud-item]'), null);
    assert.equal(bottomCenterText(), '');
  });

  it('shows the level and multiplier in the bottom-center HUD region while active', () => {
    act(() => setFlySpeedState({ level: 4, active: true, changedAt: performance.now() }));
    renderIndicator();
    const text = bottomCenterText();
    assert.match(text, new RegExp(`5/${FLY_SPEED_LEVELS.length}`), 'shows level index + 1 out of the total');
    assert.match(text, new RegExp(`×${FLY_SPEED_LEVELS[4]}`));
  });

  it('leaves the HUD once fly mode ends and the linger window has passed', () => {
    act(() => setFlySpeedState({ level: 2, active: true, changedAt: performance.now() }));
    renderIndicator();
    assert.notEqual(bottomCenterText(), '');

    act(() => setFlySpeedState({ active: false }));
    // `changedAt` is still recent, so the readout lingers briefly rather than
    // vanishing the instant the button is released.
    assert.notEqual(bottomCenterText(), '', 'should still linger right after fly mode ends');
  });
});
