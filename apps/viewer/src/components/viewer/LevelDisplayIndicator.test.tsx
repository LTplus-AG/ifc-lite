/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The level-display chip is a neutral HUD chip (#5490): it had a purple
 * border and icon of its own, the one purple status chip on the viewport.
 * It now renders on the shared HUD surface in ink, and its dismiss still
 * returns the view to Stacked.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { render, click, cleanup } from '@/test/render.js';
import { ViewportHud } from '../viewport-ui/hud/ViewportHud.js';
import { LevelDisplayIndicator } from './LevelDisplayIndicator.js';

/**
 * `LevelDisplayIndicator` now portals into `ViewportHud`'s top-left region
 * (#5504) instead of an `absolute`-positioned wrapper of its own, so every
 * test mounts the HUD host alongside it — a `HudItem` renders nothing until
 * its target region exists.
 */
function renderIndicator(): HTMLElement {
  return render(
    <>
      <ViewportHud />
      <LevelDisplayIndicator />
    </>,
  );
}

afterEach(() => {
  cleanup();
  useViewerStore.setState({ levelDisplayMode: 'stacked' });
});

/** Every class used anywhere in the rendered subtree. */
function classesIn(root: Element): string[] {
  return [root, ...root.querySelectorAll('*')].flatMap((el) => [...el.classList]);
}

describe('LevelDisplayIndicator (#5490)', () => {
  it('renders nothing while levels are stacked', () => {
    useViewerStore.setState({ levelDisplayMode: 'stacked' });
    const container = renderIndicator();
    assert.equal(container.textContent, '');
  });

  it('shows the exploded state as a neutral chip on the shared HUD surface', () => {
    useViewerStore.setState({ levelDisplayMode: 'exploded', explodedGap: 3 });
    const container = renderIndicator();
    assert.match(container.textContent ?? '', /Exploded · 3 m gap/);
    const classes = classesIn(container);
    assert.ok(classes.includes('bg-popover/[.94]'), 'uses the one HUD card surface');
    assert.deepEqual(
      classes.filter((c) => /purple|violet|indigo|fuchsia|primary/.test(c)),
      [],
      'no hue of its own: status, not accent',
    );
  });

  it('the dismiss returns the view to Stacked', () => {
    useViewerStore.setState({ levelDisplayMode: 'exploded', explodedGap: 3 });
    const container = renderIndicator();
    const dismiss = container.querySelector('button[aria-label="Back to stacked view"]');
    assert.ok(dismiss, 'the chip offers a labelled dismiss');
    assert.equal(dismiss.getAttribute('title'), 'Back to stacked');
    click(dismiss);
    assert.equal(useViewerStore.getState().levelDisplayMode, 'stacked');
  });
});
