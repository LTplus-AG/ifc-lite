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
  let fail: ((error: Error) => void) | undefined;
  const promise = new Promise<PickResult | null>((resolve, reject) => { finish = resolve; fail = reject; });
  return { promise, resolve(value: PickResult | null) { assert.ok(finish); finish(value); },
    reject(error: Error) { assert.ok(fail); fail(error); } };
}

beforeEach(() => {
  useViewerStore.getState().clearHover();
  useViewerStore.setState({ activeTool: 'select', navigationPreset: 'default', interactionMode: 'all' });
});
afterEach(() => { cleanupMouseControls(); useViewerStore.getState().clearHover(); });

function probe(t: TestContext, hoverThrottleMs = 0) {
  const calls: Array<ReturnType<typeof deferred>> = [];
  const options = { isStreaming: false, hiddenIds: new Set<number>(), isolatedIds: null } satisfies PickOptions;
  const ui = mountMouseControls({
    hoverTooltipsEnabledRef: { current: true }, hoverThrottleMs,
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
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const q = probe(t, 50); q.move();
  act(() => { t.mock.timers.tick(10); q.canvas.dispatchEvent(mousePointer('pointermove', 0, 620, 330, { buttons: 0 })); });
  assert.equal(q.calls.length, 1);
  await q.finish(0, hit(101));
  assert.equal(useViewerStore.getState().hoverState.entityId, null);
});

it('the final throttled pointer position gets a trailing mounted pick (#6881, #7389 review)', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const p = probe(t, 50); p.move();
  act(() => { t.mock.timers.tick(10); p.canvas.dispatchEvent(mousePointer('pointermove', 0, 620, 380, { buttons: 0 })); });
  await p.finish(0, hit(101));
  assert.equal(useViewerStore.getState().hoverState.entityId, null);
  act(() => { t.mock.timers.tick(39); });
  assert.equal(p.calls.length, 1, 'the original throttle interval remains bounded');
  act(() => { t.mock.timers.tick(1); });
  assert.equal(p.calls.length, 2, 'stopping the pointer must not starve its replacement pick');
  assert.deepEqual(p.pick.mock.calls[1].arguments.slice(0, 2), [600, 350]);
  await p.finish(1, hit(202));
  assert.equal(useViewerStore.getState().hoverState.entityId, 202);
  assert.equal(useViewerStore.getState().hoverState.screenX, 620);
  assert.equal(useViewerStore.getState().hoverState.screenY, 380);
});

it('a pointer burst coalesces to its newest trailing position (#6881, #7389 review)', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const p = probe(t, 50); p.move();
  for (const x of [520, 620, 720]) {
    act(() => { t.mock.timers.tick(10); p.canvas.dispatchEvent(mousePointer('pointermove', 0, x, 330, { buttons: 0 })); });
  }
  act(() => { t.mock.timers.tick(20); });
  assert.equal(p.calls.length, 2, 'one leading and one latest trailing pick');
  assert.deepEqual(p.pick.mock.calls[1].arguments.slice(0, 2), [700, 300]);
  await p.finish(1, hit(202));
  await p.finish(0, null);
  assert.equal(useViewerStore.getState().hoverState.entityId, 202);
  assert.equal(useViewerStore.getState().hoverState.screenX, 720);
});

for (const loss of ['leave', 'down', 'cancel', 'unmount'] as const) {
  it(`pending trailing hover is canceled by ${loss} (#6881, #7389 review)`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const p = probe(t, 50); p.move();
    act(() => { t.mock.timers.tick(10); p.canvas.dispatchEvent(mousePointer('pointermove', 0, 620, 330, { buttons: 0 })); });
    if (loss === 'unmount') cleanupMouseControls();
    else act(() => { p.canvas.dispatchEvent(loss === 'leave' ? new MouseEvent('mouseleave')
      : mousePointer(loss === 'down' ? 'pointerdown' : 'pointercancel', 0, 620, 330, { buttons: loss === 'down' ? 1 : 0 })); });
    act(() => { t.mock.timers.tick(100); });
    assert.equal(p.calls.length, 1, 'retired timers must not launch a renderer pick');
    await p.finish(0, hit(101));
    assert.equal(useViewerStore.getState().hoverState.entityId, null);
  });
}

for (const change of ['disabled', 'tool', 'renderer', 'camera', 'bounds'] as const) {
  it(`pending trailing hover refuses changed ${change} ownership (#6881, #7389 review)`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const p = probe(t, 50); p.move();
    act(() => { t.mock.timers.tick(10); p.canvas.dispatchEvent(mousePointer('pointermove', 0, 620, 330, { buttons: 0 })); });
    if (change === 'disabled') p.params.hoverTooltipsEnabledRef.current = false;
    if (change === 'tool') p.params.activeToolRef.current = 'section';
    if (change === 'renderer') p.params.rendererRef.current = null;
    if (change === 'camera') p.camera.setPosition(1, 2, 3);
    if (change === 'bounds') p.canvas.getBoundingClientRect = () => ({ left: 30, top: 30, width: 800, height: 600,
      right: 830, bottom: 630, x: 30, y: 30, toJSON: () => ({}) });
    act(() => { t.mock.timers.tick(100); });
    assert.equal(p.calls.length, 1, 'validity is checked before deferred GPU work begins');
    await p.finish(0, hit(101));
    assert.equal(useViewerStore.getState().hoverState.entityId, null);
  });
}

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

// A rejected renderer operation is an application failure boundary, not native device-loss proof.
it('a failed trailing readback clears current hover without an unhandled rejection (#6881, #7389 review)', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const warn = t.mock.method(console, 'warn', () => {});
  const p = probe(t, 50); p.move(); await p.finish(0, hit(101));
  assert.equal(useViewerStore.getState().hoverState.entityId, 101);
  act(() => { t.mock.timers.tick(10); p.canvas.dispatchEvent(mousePointer('pointermove', 0, 620, 330, { buttons: 0 })); });
  act(() => { t.mock.timers.tick(40); });
  assert.equal(p.calls.length, 2);
  await act(async () => { p.calls[1].reject(new Error('renderer readback unavailable')); await Promise.resolve(); });
  assert.equal(useViewerStore.getState().hoverState.entityId, null);
  assert.equal(warn.mock.calls.length, 1);
});

// Mounted application ownership only: no native focus, map, or device-loss acceptance.
it('generic blur retires trailing and in-flight hover without a command press (#6881, #7389 review)', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const p = probe(t, 50); p.move(); await p.finish(0, hit(101));
  assert.equal(p.params.activeToolRef.current, 'select', 'no modeling command press exists');
  act(() => { t.mock.timers.tick(10); p.canvas.dispatchEvent(mousePointer('pointermove', 0, 620, 330, { buttons: 0 })); });
  act(() => { window.dispatchEvent(new Event('blur')); });
  const afterBlurEntity = useViewerStore.getState().hoverState.entityId;
  act(() => { t.mock.timers.tick(40); });
  const afterTrailingPickCount = p.calls.length;
  // Drain an incorrectly dispatched pre-repair operation so the before run also cleans up.
  if (p.calls.length > 1) await p.finish(1, hit(202));
  const next = p.calls.length; p.move();
  assert.equal(p.calls.length, next + 1, 'the mounted listener reaches an in-flight renderer boundary');
  act(() => { window.dispatchEvent(new Event('blur')); });
  await p.finish(next, hit(303));
  assert.deepEqual({ afterBlurEntity, afterTrailingPickCount,
    afterLateReadbackEntity: useViewerStore.getState().hoverState.entityId },
  { afterBlurEntity: null, afterTrailingPickCount: 1, afterLateReadbackEntity: null });
});
