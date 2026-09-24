/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from '@/test/render.js';
import { ViewportHud } from './ViewportHud.js';
import { HudItem } from './HudItem.js';
import { HudSurface } from './HudSurface.js';
import { HudHint } from './HudHint.js';

installLayout();

afterEach(() => {
  cleanup();
});

describe('ViewportHud region ordering (#5485)', () => {
  it('places items in a region by `order`, independent of mount sequence', () => {
    // Mounted out of visual order on purpose: C first, A last. If HudItem
    // fell back to DOM/mount order instead of honouring `order`, this would
    // read back C, B, A.
    render(
      <ViewportHud />,
    );
    render(
      <>
        <HudItem region="top-left" order={2}>
          <span data-testid="C">C</span>
        </HudItem>
        <HudItem region="top-left" order={0}>
          <span data-testid="A">A</span>
        </HudItem>
        <HudItem region="top-left" order={1}>
          <span data-testid="B">B</span>
        </HudItem>
      </>,
    );

    const region = document.querySelector('[data-hud-region="top-left"]');
    assert.ok(region, 'top-left region node exists once ViewportHud is mounted');
    const items = Array.from(region!.querySelectorAll('[data-hud-item]'));
    assert.equal(items.length, 3);

    // The visual order a flex `order` CSS property would render, computed
    // from the SAME inline style HudItem set — the mechanism under test,
    // not the DOM insertion order (which is deliberately scrambled above).
    const byVisualOrder = [...items].sort(
      (a, b) => Number((a as HTMLElement).style.order) - Number((b as HTMLElement).style.order),
    );
    assert.deepEqual(
      byVisualOrder.map((el) => el.textContent),
      ['A', 'B', 'C'],
    );
  });

  it('never mixes items from two different regions into the same DOM node', () => {
    render(<ViewportHud />);
    render(
      <>
        <HudItem region="top-left" order={0}>
          <span>left</span>
        </HudItem>
        <HudItem region="bottom-right" order={0}>
          <span>right</span>
        </HudItem>
      </>,
    );

    const topLeft = document.querySelector('[data-hud-region="top-left"]')!;
    const bottomRight = document.querySelector('[data-hud-region="bottom-right"]')!;
    assert.notEqual(topLeft, bottomRight);
    assert.match(topLeft.textContent ?? '', /left/);
    assert.doesNotMatch(topLeft.textContent ?? '', /right/);
    assert.match(bottomRight.textContent ?? '', /right/);
    assert.doesNotMatch(bottomRight.textContent ?? '', /left/);
  });

  it('renders nothing for a HudItem mounted before ViewportHud exists', () => {
    // No <ViewportHud /> mounted in this test at all — `hud-regions.ts`'s
    // registry is empty, so the portal target does not exist yet.
    // `HudItem` portals via `createPortal`, so a bad fallback (e.g.
    // portaling to `document.body` when the region is missing) would place
    // its marker OUTSIDE `render()`'s own container — check the whole
    // document, not just the local container, or that escape goes unnoticed.
    render(
      <HudItem region="top-left" order={0}>
        <span>orphan</span>
      </HudItem>,
    );
    assert.equal(document.querySelector('[data-hud-item]'), null);
    assert.doesNotMatch(document.body.textContent ?? '', /orphan/);
  });
});

describe('ViewportHud pointer-events and overlap-by-construction (#5485)', () => {
  it('marks the host and every region pointer-events-none, letting a HudSurface control opt back in', () => {
    render(<ViewportHud />);
    render(
      <HudItem region="top-center" order={0}>
        <HudSurface data-testid="surface">bar</HudSurface>
      </HudItem>,
    );

    const host = document.querySelector('[data-testid="viewport-hud"]');
    assert.ok(host);
    assert.ok(host!.className.includes('pointer-events-none'));

    const region = document.querySelector('[data-hud-region="top-center"]');
    assert.ok(region);
    assert.ok(region!.className.includes('pointer-events-none'));

    const surface = document.querySelector('[data-testid="surface"]');
    assert.ok(surface);
    assert.ok(surface!.className.includes('pointer-events-auto'));

    // A passive HudHint stays pointer-events-none: it is not a control, so
    // it must never swallow a click meant for the canvas beneath it.
    const hintUi = render(<HudHint>hint text</HudHint>);
    const hint = hintUi.firstElementChild!;
    assert.ok(hint.className.includes('pointer-events-none'));
    assert.ok(!hint.className.includes('pointer-events-auto'));
  });

  it('lays out every region as a flex column so items stack instead of overlapping, and never absolute-positions a HudItem', () => {
    render(<ViewportHud />);
    render(
      <>
        <HudItem region="bottom-left" order={0}>
          <span>one</span>
        </HudItem>
        <HudItem region="bottom-left" order={1}>
          <span>two</span>
        </HudItem>
      </>,
    );

    const region = document.querySelector('[data-hud-region="bottom-left"]') as HTMLElement;
    assert.ok(region.className.includes('flex'));
    assert.ok(region.className.includes('flex-col'));

    // Overlap is prevented BY CONSTRUCTION: normal-flow flex children in a
    // column stack instead of overlapping. happy-dom does not implement
    // layout (every `getBoundingClientRect()` is a flat stub, see
    // `dom-layout.js`), so the real pixel-disjoint proof is the HUD
    // collision e2e (#5478 item 5) in a real browser; this asserts the
    // mechanism that guarantees it: no `HudItem` wrapper is ever taken out
    // of normal flow.
    for (const item of Array.from(region.querySelectorAll('[data-hud-item]'))) {
      const el = item as HTMLElement;
      assert.notEqual(el.style.position, 'absolute');
      assert.notEqual(el.style.position, 'fixed');
    }
  });
});
