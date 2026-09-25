/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `useProjectorTick` (#5510): asserts it re-renders on a dirty projector
 * tick, stays put on an idle one, does nothing when `active` is false, and
 * that two concurrent instances (the real shape in `ToolOverlays` —
 * `GizmoOverlay` + `WallEndpointOverlay` both mount at once) don't collide
 * on the anchor id and silently drop one caller's wake. Mutation-checked:
 * each assertion was verified to fail when the guarded behaviour was
 * reverted (noted inline).
 */

import '@/test/setup-dom.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup } from '@/test/render.js';
import { useProjectorTick } from './useProjectorTick.js';
import { renderScene } from './test/scene-test-support.js';

function TickProbe({ active, label }: { active: boolean; label: string }) {
  const tick = useProjectorTick(active);
  return <div data-testid={label}>{tick}</div>;
}

function readTick(container: HTMLElement, label: string): number {
  const el = container.querySelector(`[data-testid="${label}"]`);
  if (!el) throw new Error(`missing probe ${label}`);
  return Number(el.textContent);
}

describe('useProjectorTick', () => {
  afterEach(() => cleanup());

  it('advances on a dirty projector tick and stays put on an idle one', () => {
    const { container, source, flush } = renderScene(<TickProbe active label="a" />);
    assert.equal(readTick(container, 'a'), 0, 'no tick has run yet');

    // A dirty tick: real camera motion.
    source.dirty = true;
    act(() => {
      flush();
    });
    assert.equal(readTick(container, 'a'), 1, 'a dirty tick must wake the probe');

    // A dirty tick always re-arms exactly one more "check again" frame
    // (`projector.ts` `tick()`: motion this frame doesn't guarantee motion
    // next frame). With the source now clean, that one frame finds nothing
    // dirty and runs no anchor listener — so it still executes (`ran === 1`)
    // but must NOT advance the probe. Reverting `useProjectorTick` to call
    // `setTick` unconditionally on every registration (rather than per
    // dirty tick from the projector) would also pass the FIRST assertion
    // above; this one is what distinguishes "wakes on dirty ticks" from
    // "wakes once at mount and keeps counting every scheduled frame".
    source.dirty = false;
    act(() => {
      const ran = flush();
      assert.equal(ran, 1, 'the projector re-arms exactly one settling frame after a dirty tick');
    });
    assert.equal(readTick(container, 'a'), 1, 'a settling (non-dirty) tick must not advance the probe');

    // The loop is now truly idle: nothing queued at all.
    act(() => {
      const ran = flush();
      assert.equal(ran, 0, 'an idle projector must not have a frame queued at all');
    });
    assert.equal(readTick(container, 'a'), 1, 'still unchanged once the loop has gone fully idle');
  });

  it('does nothing while inactive', () => {
    const { container, source, flush } = renderScene(<TickProbe active={false} label="b" />);
    source.dirty = true;
    act(() => {
      flush();
    });
    assert.equal(readTick(container, 'b'), 0, 'an inactive hook must never register an anchor');
  });

  it('two concurrent instances each get their own anchor id and both wake', () => {
    // Reverting `useProjectorTick` to a fixed anchor id (e.g.
    // `'projector-tick-wake'` for every instance) makes this fail: the
    // second `registerAnchor` call overwrites the first in the
    // projector's anchor map (`Map.set` on the same key), so only ONE of
    // the two probes below would ever advance past 0 — the exact bug
    // `GizmoOverlay` + `WallEndpointOverlay` mounting together under one
    // `SceneOverlayRoot` would hit in production.
    const { container, source, flush } = renderScene(
      <>
        <TickProbe active label="x" />
        <TickProbe active label="y" />
      </>,
    );
    source.dirty = true;
    act(() => {
      flush();
    });
    assert.equal(readTick(container, 'x'), 1, 'the first instance must wake');
    assert.equal(readTick(container, 'y'), 1, 'the second instance must ALSO wake, not be dropped by an id collision');
  });
});
