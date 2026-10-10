/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6881: real mounted pointer handlers must own the async hover completion.
// Deferred renderer responses are an explicit application boundary, not GPU
// rasterisation/model identity evidence. Execute through root Turbo only.
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it, type TestContext } from 'node:test';
import { act } from 'react';
import type { PickOptions, PickResult } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { mousePointer, mountMouseControls, cleanupMouseControls } from '@/test/mouse-controls-fixture';

const hit = (expressId: number): PickResult => ({ expressId, modelIndex: 0, worldXYZ: { x: 1, y: 2, z: 3 } });
function deferred() {
  let finish: ((value: PickResult | null) => void) | undefined;
  const promise = new Promise<PickResult | null>(resolve => { finish = resolve; });
  return { promise, resolve(value: PickResult | null) { assert.ok(finish); finish(value); } };
}

beforeEach(() => {
  useViewerStore.getState().clearHover();
  useViewerStore.setState({ activeTool: 'select', navigationPreset: 'default', interactionMode: 'all' });
});
afterEach(() => { cleanupMouseControls(); useViewerStore.getState().clearHover(); });

function probe(t: TestContext) {
  const calls: Array<ReturnType<typeof deferred>> = [];
  const options = { isStreaming: false, hiddenIds: new Set<number>(), isolatedIds: null } satisfies PickOptions;
  const ui = mountMouseControls({
    hoverTooltipsEnabledRef: { current: true }, hoverThrottleMs: 0,
    setHoverState: state => useViewerStore.getState().setHoverState(state),
    clearHover: () => useViewerStore.getState().clearHover(),
    getPickOptions: () => options,
  }, (_camera, canvas) => {
    canvas.getBoundingClientRect = () => ({ left: 20, top: 30, width: 800, height: 600,
      right: 820, bottom: 630, x: 20, y: 30, toJSON: () => ({}) });
  });
  assert.ok(ui.params.rendererRef.current);
  const pick = t.mock.method(ui.params.rendererRef.current, 'pick', () => {
    const call = deferred(); calls.push(call); return call.promise;
  });
  const move = (x = 420, y = 330, throttled = false) => {
    ui.params.lastHoverCheckRef.current = throttled ? Date.now() : 0;
    act(() => { ui.canvas.dispatchEvent(mousePointer('pointermove', 0, x, y, { buttons: 0 })); });
  };
  const finish = async (index: number, result: PickResult | null) => {
    assert.ok(calls[index], 'the mounted listener must actually reach the renderer boundary');
    await act(async () => { calls[index].resolve(result); await calls[index].promise; });
  };
  return { ...ui, calls, pick, move, finish };
}

it('commits a current mounted hover with original client coordinates (#6881 hover)', async t => {
  const p = probe(t); p.move();
  assert.equal(p.calls.length, 1);
  assert.deepEqual(p.pick.mock.calls[0].arguments.slice(0, 2), [400, 300], 'canvas offsets are applied by the real handler');
  await p.finish(0, hit(101));
  assert.deepEqual(useViewerStore.getState().hoverState,
    { entityId: 101, screenX: 420, screenY: 330, worldXYZ: { x: 1, y: 2, z: 3 }, modelIndex: 0 });
});

for (const old of [hit(101), null]) {
  it(`older ${old ? 'hit' : 'miss'} cannot replace a newer mounted hover (#6881 hover)`, async t => {
    const p = probe(t); p.move(); p.move(620, 330);
    assert.equal(p.calls.length, 2);
    await p.finish(1, hit(202));
    assert.equal(useViewerStore.getState().hoverState.entityId, 202);
    await p.finish(0, old);
    assert.equal(useViewerStore.getState().hoverState.entityId, 202);
    assert.equal(useViewerStore.getState().hoverState.screenX, 620);
  });
}

for (const loss of ['leave', 'cancel', 'unmount'] as const) {
  it(`late readback cannot revive hover after ${loss} (#6881 hover)`, async t => {
    const p = probe(t); p.move(); assert.equal(p.calls.length, 1);
    if (loss === 'unmount') cleanupMouseControls();
    else act(() => { p.canvas.dispatchEvent(loss === 'leave' ? new MouseEvent('mouseleave')
      : mousePointer('pointercancel', 0, 420, 330, { buttons: 0 })); });
    assert.equal(useViewerStore.getState().hoverState.entityId, null);
    await p.finish(0, hit(101));
    assert.equal(useViewerStore.getState().hoverState.entityId, null);
  });
}

it('throttled pointer movement retires the old position (#6881 hover)', async t => {
  const q = probe(t); q.move();
  // A far-future last-check value guarantees the second event is throttled even
  // with the probe's zero throttle; no wall-clock sleep or deadline extension.
  q.params.lastHoverCheckRef.current = Number.MAX_SAFE_INTEGER;
  act(() => { q.canvas.dispatchEvent(mousePointer('pointermove', 0, 620, 330, { buttons: 0 })); });
  assert.equal(q.calls.length, 1);
  await q.finish(0, hit(101));
  assert.equal(useViewerStore.getState().hoverState.entityId, null);
});

for (const change of ['disabled', 'tool', 'renderer'] as const) {
  it(`late hover cannot survive ${change} ownership change (#6881 hover)`, async t => {
    const p = probe(t); p.move(); assert.equal(p.calls.length, 1);
    if (change === 'disabled') p.params.hoverTooltipsEnabledRef.current = false;
    if (change === 'tool') p.params.activeToolRef.current = 'section';
    if (change === 'renderer') p.params.rendererRef.current = null;
    await p.finish(0, hit(101));
    assert.equal(useViewerStore.getState().hoverState.entityId, null);
  });
}
