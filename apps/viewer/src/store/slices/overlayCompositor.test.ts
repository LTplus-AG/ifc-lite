/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compositor reconciliation logic — unit-tested in isolation from React.
 *
 * The `useOverlayCompositor` hook's reconciliation loop (what-we-wrote vs.
 * what-the-layers-want + user-isolation preservation) is extracted from
 * the React shape so we can assert the delta math without a renderer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { composeLayers, type OverlayLayer, type RGBA } from './overlaySlice.js';

/** Same logic as `useOverlayCompositor`, without React. */
function reconcile(args: {
  prevContributedHidden: Map<number, boolean>;
  prevContributedColors: Set<number>;
  layers: Map<string, OverlayLayer>;
  currentlyHidden: Set<number>;
}): {
  hideDelta: number[];
  showDelta: number[];
  nextColors: Map<number, RGBA> | 'clear' | 'unchanged';
  nextContributedHidden: Map<number, boolean>;
  nextContributedColors: Set<number>;
} {
  const { hiddenIds: nextHidden, colorOverrides: nextColors } = composeLayers(args.layers);

  // Hidden delta — unhide only ids whose "was already hidden by user"
  // bit is false (we own them).
  const showDelta: number[] = [];
  for (const [id, wasHidden] of args.prevContributedHidden) {
    if (!nextHidden.has(id) && wasHidden === false) showDelta.push(id);
  }
  const hideDelta: number[] = [];
  const nextContributedHidden = new Map<number, boolean>();
  for (const id of nextHidden) {
    if (args.prevContributedHidden.has(id)) {
      nextContributedHidden.set(id, args.prevContributedHidden.get(id)!);
    } else {
      const wasHidden = args.currentlyHidden.has(id);
      nextContributedHidden.set(id, wasHidden);
      if (!wasHidden) hideDelta.push(id);
    }
  }

  // Colours are all-or-nothing.
  let nextColorsResult: Map<number, RGBA> | 'clear' | 'unchanged';
  let nextContributedColors: Set<number>;
  if (nextColors.size > 0) {
    nextColorsResult = nextColors;
    nextContributedColors = new Set(nextColors.keys());
  } else if (args.prevContributedColors.size > 0) {
    nextColorsResult = 'clear';
    nextContributedColors = new Set();
  } else {
    nextColorsResult = 'unchanged';
    nextContributedColors = new Set();
  }

  return {
    hideDelta,
    showDelta,
    nextColors: nextColorsResult,
    nextContributedHidden,
    nextContributedColors,
  };
}

const RED: RGBA = [1, 0, 0, 1];

function mkLayer(id: string, priority: number, opts: {
  hide?: Iterable<number>;
  colour?: Iterable<[number, RGBA]>;
} = {}): OverlayLayer {
  return {
    id,
    priority,
    hiddenIds: opts.hide ? new Set(opts.hide) : null,
    colorOverrides: opts.colour ? new Map(opts.colour) : null,
  };
}

describe('overlay compositor — reconciliation', () => {
  it("preserves user's prior isolation — doesn't unhide ids the user had hidden first", () => {
    // User had id 5 already hidden (via class filter, say). Animation
    // layer then registers it too.
    const r1 = reconcile({
      prevContributedHidden: new Map(),
      prevContributedColors: new Set(),
      layers: new Map([['animation', mkLayer('animation', 100, { hide: [5] })]]),
      currentlyHidden: new Set([5]), // user already hid this
    });
    // We don't re-hide (hideEntities would be a no-op anyway, but we
    // track "was already hidden" = true so we don't unhide on teardown).
    assert.deepStrictEqual(r1.hideDelta, []);
    assert.strictEqual(r1.nextContributedHidden.get(5), true);

    // Layer goes away — we must NOT unhide 5, the user still wants it hidden.
    const r2 = reconcile({
      prevContributedHidden: r1.nextContributedHidden,
      prevContributedColors: new Set(),
      layers: new Map(),
      currentlyHidden: new Set([5]),
    });
    assert.deepStrictEqual(r2.showDelta, []);
  });

  it('colour overrides are full-replace — empty layers signal a clear exactly once', () => {
    // Layer writes a colour; next tick layer is gone — we issue clear.
    const r1 = reconcile({
      prevContributedHidden: new Map(),
      prevContributedColors: new Set(),
      layers: new Map([['animation', mkLayer('animation', 100, { colour: [[5, RED]] })]]),
      currentlyHidden: new Set(),
    });
    assert.notStrictEqual(r1.nextColors, 'clear');
    assert.notStrictEqual(r1.nextColors, 'unchanged');

    const r2 = reconcile({
      prevContributedHidden: r1.nextContributedHidden,
      prevContributedColors: r1.nextContributedColors,
      layers: new Map(),
      currentlyHidden: new Set(),
    });
    assert.strictEqual(r2.nextColors, 'clear');

    // Subsequent reconcile with still-empty colours → 'unchanged' (no
    // redundant clear).
    const r3 = reconcile({
      prevContributedHidden: r2.nextContributedHidden,
      prevContributedColors: r2.nextContributedColors,
      layers: new Map(),
      currentlyHidden: new Set(),
    });
    assert.strictEqual(r3.nextColors, 'unchanged');
  });

  it('layer swap — adds new ids, removes dropped ids (owned only)', () => {
    // Start: animation hides {1, 2}; user had 2 pre-hidden.
    const r1 = reconcile({
      prevContributedHidden: new Map(),
      prevContributedColors: new Set(),
      layers: new Map([['animation', mkLayer('animation', 100, { hide: [1, 2] })]]),
      currentlyHidden: new Set([2]),
    });
    // Tick: layer now hides {2, 3}. Id 1 should be unhidden (we owned it).
    // Id 2 stays hidden (user owns). Id 3 hides (new).
    const r2 = reconcile({
      prevContributedHidden: r1.nextContributedHidden,
      prevContributedColors: new Set(),
      layers: new Map([['animation', mkLayer('animation', 100, { hide: [2, 3] })]]),
      currentlyHidden: new Set([1, 2]), // store state after r1's writes
    });
    assert.deepStrictEqual(r2.showDelta.sort((a, b) => a - b), [1]);
    assert.deepStrictEqual(r2.hideDelta.sort((a, b) => a - b), [3]);
    // After swap: id 2's ownership bit still says "user owns".
    assert.strictEqual(r2.nextContributedHidden.get(2), true);
    assert.strictEqual(r2.nextContributedHidden.get(3), false);
  });
});
