/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewControls } from './useViewControls.js';
import { useViewerStore } from '@/store/index.js';
import type { DrawingViewTransform } from '@/lib/drawing/wheel-navigation.js';
import type { CachedSheetTransform } from '@/lib/drawing/sheet-geometry-key.js';

const rect = { left: 40, top: 30, width: 800, height: 600 };
const initial = { x: 20, y: 40, scale: 10 };
const pointer = { clientX: 240, clientY: 180 };
let latest: ReturnType<typeof useViewControls>;
let root: Root | null = null;
const host = document.createElement('div');
const canvas = document.createElement('div');
const inspector = document.createElement('div');
document.body.append(host, canvas, inspector);
canvas.getBoundingClientRect = () => ({ ...rect, x: rect.left, y: rect.top, right: 840, bottom: 630, toJSON: () => ({}) });
const containerRef = { current: canvas as HTMLDivElement | null };

function Harness({ visible = true }: { visible?: boolean }) {
  const cache = useRef<CachedSheetTransform | null>(null);
  latest = useViewControls({ drawing: null, containerRef, panelVisible: visible, status: 'ready',
    sectionPlane: { axis: 'side', position: 50, flipped: false }, sheetEnabled: false,
    activeSheet: null, isPinned: true, cachedSheetTransformRef: cache });
  return null;
}
async function mount(visible = true) {
  await act(async () => {
    root ??= createRoot(host);
    root.render(<Harness visible={visible} />);
  });
}
async function reset(value: DrawingViewTransform = initial) {
  await act(async () => latest.setViewTransform(value));
}
async function wheel(options: WheelEventInit = {}, target: HTMLElement = canvas) {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...pointer, ...options });
  // happy-dom's WheelEvent incorrectly extends UIEvent, losing the inherited
  // MouseEvent coordinates/modifiers that every browser wheel event provides.
  Object.defineProperties(event, {
    clientX: { value: options.clientX ?? pointer.clientX }, clientY: { value: options.clientY ?? pointer.clientY },
    ctrlKey: { value: options.ctrlKey ?? false }, metaKey: { value: options.metaKey ?? false },
  });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}
function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}
function landmark(t: DrawingViewTransform) {
  return { x: (pointer.clientX - rect.left - t.x) / t.scale, y: (pointer.clientY - rect.top - t.y) / t.scale };
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  containerRef.current = canvas;
  useViewerStore.setState({ navigationPreset: 'default' });
  window.dispatchEvent(new Event('blur'));
});

describe('drawing wheel navigation (#6614)', () => {
  it('uses magnitude, preserves the pointer landmark, and reverses equal opposite input', async () => {
    await mount(); await reset();
    const before = landmark(latest.viewTransform);
    assert.equal((await wheel({ deltaY: 1 })).defaultPrevented, true);
    const small = latest.viewTransform.scale;
    await reset(); await wheel({ deltaY: 100 });
    assert.ok(small > latest.viewTransform.scale && small < initial.scale);
    near(latest.viewTransform.scale, initial.scale / 1.1);
    near(landmark(latest.viewTransform).x, before.x);
    near(landmark(latest.viewTransform).y, before.y);
    await wheel({ deltaY: -100 });
    near(latest.viewTransform.scale, initial.scale);
    near(latest.viewTransform.x, initial.x); near(latest.viewTransform.y, initial.y);
  });

  it('normalizes pixel, line and page units before navigation', async () => {
    await mount();
    for (const [deltaY, deltaMode] of [[96, 0], [6, 1], [0.16, 2]]) {
      await reset(); await wheel({ deltaY, deltaMode });
      near(latest.viewTransform.scale, initial.scale * Math.exp(-Math.log(1.1) * 0.96));
    }
  });

  it('ignores zero, pans Default horizontal scroll, and keeps inspector events local', async () => {
    await mount(); await reset();
    await wheel(); assert.deepEqual(latest.viewTransform, initial);
    await wheel({ deltaX: 100 });
    assert.deepEqual(latest.viewTransform, { ...initial, x: initial.x - 100 });
    await reset();
    assert.equal((await wheel({ deltaY: 100 }, inspector)).defaultPrevented, false);
    assert.deepEqual(latest.viewTransform, initial);
  });

  it('tracks Ctrl and Cmd in capture phase, preserves normal pinch, and resets on keyup/blur', async () => {
    await mount();
    const editor = document.createElement('input'); canvas.append(editor);
    editor.addEventListener('keydown', (event) => event.stopPropagation());
    for (const key of ['Control', 'Meta']) {
      const modifier = key === 'Control' ? { ctrlKey: true } : { metaKey: true };
      await reset(); await wheel({ deltaY: 100, ...modifier });
      near(latest.viewTransform.scale, initial.scale / 1.1); // no physical press: pinch
      editor.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...modifier }));
      await reset(); await wheel({ deltaY: 100, ...modifier });
      near(latest.viewTransform.scale, initial.scale * Math.exp(-Math.log(1.1) * 0.2));
      // A wheel render must not dispose/recreate the physical modifier tracker.
      await wheel({ deltaY: 100, ...modifier });
      near(latest.viewTransform.scale, initial.scale * Math.exp(-Math.log(1.1) * 0.4));
      editor.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
      await reset(); await wheel({ deltaY: 100, ...modifier });
      near(latest.viewTransform.scale, initial.scale / 1.1);
      editor.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...modifier }));
      window.dispatchEvent(new Event('blur'));
      await reset(); await wheel({ deltaY: 100, ...modifier });
      near(latest.viewTransform.scale, initial.scale / 1.1);
    }
    editor.remove();
  });

  it('reacts to presets without reopening and consumes only the mounted visible canvas', async () => {
    await mount(); await reset();
    await act(async () => useViewerStore.setState({ navigationPreset: 'trackpad' }));
    await wheel({ deltaX: 2, deltaY: 3, deltaMode: 1 });
    assert.deepEqual(latest.viewTransform, { ...initial, x: initial.x - 32, y: initial.y - 48 });
    await reset(); await wheel({ deltaY: 100, ctrlKey: true });
    near(latest.viewTransform.scale, initial.scale / 1.1);
    await act(async () => useViewerStore.setState({ navigationPreset: 'navisworks' }));
    await reset(); await wheel({ deltaX: 100 }); assert.deepEqual(latest.viewTransform, initial);
    await mount(false);
    assert.equal((await wheel({ deltaY: 100 })).defaultPrevented, false);
    await mount(); await reset(); await wheel({ deltaY: 100 });
    near(latest.viewTransform.scale, initial.scale / 1.1); // exactly one listener
  });

  it('rebinds to a replaced container and removes all listeners on unmount', async () => {
    await mount();
    const replacement = document.createElement('div');
    replacement.getBoundingClientRect = canvas.getBoundingClientRect;
    document.body.append(replacement);
    containerRef.current = replacement;
    await mount(); await reset();
    assert.equal((await wheel({ deltaY: 100 })).defaultPrevented, false);
    assert.equal((await wheel({ deltaY: 100 }, replacement)).defaultPrevented, true);
    near(latest.viewTransform.scale, initial.scale / 1.1);
    await act(async () => root!.unmount()); root = null;
    assert.equal((await wheel({ deltaY: 100 }, replacement)).defaultPrevented, false);
    replacement.remove();
  });

  it('tracks the pop-out owner window after the canvas is adopted', async () => {
    await mount();
    const frame = document.createElement('iframe'); document.body.append(frame);
    const owner = frame.contentWindow;
    assert.ok(owner);
    // happy-dom makes ownerDocument non-configurable on adoption, so use a
    // disposable canvas here rather than trying to adopt it back afterwards.
    const popupCanvas = document.createElement('div');
    popupCanvas.getBoundingClientRect = canvas.getBoundingClientRect;
    containerRef.current = popupCanvas;
    owner.document.body.append(owner.document.adoptNode(popupCanvas));
    await mount(); await reset();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));
    await wheel({ deltaY: 100, ctrlKey: true }, popupCanvas);
    near(latest.viewTransform.scale, initial.scale / 1.1); // old owner no longer controls fine zoom
    owner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));
    await reset(); await wheel({ deltaY: 100, ctrlKey: true }, popupCanvas);
    near(latest.viewTransform.scale, initial.scale * Math.exp(-Math.log(1.1) * 0.2));
    frame.remove();
  });

  it('rejects non-finite input/geometry and clamps step and minimum without losing the anchor', async () => {
    // The revert oracle removes newly added production modules. Keep that
    // absence an asserted regression instead of a file-level import failure;
    // the mounted tests above still exercise the existing hook after revert.
    const module = await import('@/lib/drawing/wheel-navigation.js').catch(() => null);
    assert.ok(module, 'drawing wheel normalization must be available');
    const { drawingWheelTransform } = module;
    const event = { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, ...pointer };
    for (const deltaY of [NaN, Infinity, -Infinity]) {
      assert.equal(drawingWheelTransform(initial, { ...event, deltaY }, rect, 'default', false), initial);
    }
    assert.equal(drawingWheelTransform(initial, event, { ...rect, width: 0 }, 'default', false), initial);
    assert.equal(drawingWheelTransform({ ...initial, scale: Number.MAX_VALUE },
      { ...event, deltaY: -1000 }, rect, 'default', false).scale, Number.MAX_VALUE);
    near(drawingWheelTransform(initial, { ...event, deltaY: -10000 }, rect, 'default', false).scale, 12.5);
    const minimum = drawingWheelTransform({ ...initial, scale: 0.011 }, { ...event, deltaY: 10000 }, rect, 'default', false);
    near(minimum.scale, 0.01);
    near(landmark(minimum).x, landmark({ ...initial, scale: 0.011 }).x);
  });
});
