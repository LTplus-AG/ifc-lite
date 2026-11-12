/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9718: the sheet's snaps are shares of the area it lives in (the mobile
 * viewport, which excludes the command bar), and a resize of that area keeps
 * the snap the sheet rests at instead of resetting it to the default. A
 * keyboard opening while an expanded sheet's field has focus must not drop
 * the sheet back to its default height.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { MobileBottomSheet } from './MobileBottomSheet';

let areaHeight = 0;
const observers: Array<() => void> = [];
const originalClientHeight = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'clientHeight');
const originalResizeObserver = globalThis.ResizeObserver;

class FakeResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe(): void { observers.push(this.callback); }
  unobserve(): void {}
  disconnect(): void {}
}

function resizeArea(height: number): void {
  areaHeight = height;
  act(() => { for (const notify of observers) notify(); });
}

function mountSheet(): HTMLElement {
  const host = render(
    <div data-test-area>
      <MobileBottomSheet title="Properties" onClose={() => {}}>body</MobileBottomSheet>
    </div>,
  );
  const sheet = host.querySelector<HTMLElement>('[data-mobile-sheet]');
  assert.ok(sheet, 'the sheet renders');
  return sheet;
}

function flickUp(sheet: HTMLElement): void {
  const handle = sheet.firstElementChild;
  assert.ok(handle, 'the drag handle renders');
  act(() => {
    handle.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, clientY: 300, pointerId: 1, pointerType: 'touch' }));
    handle.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, clientY: 100, pointerId: 1, pointerType: 'touch' }));
  });
}

describe('MobileBottomSheet snaps (#9718)', () => {
  beforeEach(() => {
    observers.length = 0;
    Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.hasAttribute('data-test-area') ? areaHeight : 0; },
    });
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    cleanup();
    if (originalClientHeight) Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', originalClientHeight);
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('opens at a share of its area, not of the window', () => {
    areaHeight = 500;
    const sheet = mountSheet();
    assert.equal(sheet.style.height, '300px');
  });

  it('keeps the expanded snap when the area shrinks, and fits the new size', () => {
    areaHeight = 800;
    const sheet = mountSheet();
    flickUp(sheet);
    assert.equal(sheet.style.height, `${Math.round(800 * 0.92)}px`);
    resizeArea(400);
    assert.equal(sheet.style.height, `${Math.round(400 * 0.92)}px`, 'still expanded, sized to the smaller area');
  });

  it('keeps the default snap through a resize', () => {
    areaHeight = 800;
    const sheet = mountSheet();
    resizeArea(600);
    assert.equal(sheet.style.height, '360px');
  });
});
