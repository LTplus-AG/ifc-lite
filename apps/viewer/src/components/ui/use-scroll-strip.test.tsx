/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `TabsList scrollable` (#8802): the strip scrolls only itself to keep the
 * selected tab clear of the fade, and a plain tab list stays untouched.
 * Geometry is stubbed (happy-dom has no layout): a 300 px strip holding
 * four 150 px tabs, so the last tab sits wholly past the right edge.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { advance, cleanup, mouseDown, render } from '@/test/render.js';
import { Tabs, TabsList, TabsTrigger } from './tabs.js';

const STRIP = 300;
const TAB = 150;
const VALUES = ['a', 'b', 'c', 'd'] as const;

function stubGeometry(): () => void {
  const proto = HTMLElement.prototype;
  const keys = ['scrollWidth', 'clientWidth', 'getBoundingClientRect'] as const;
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const);
  const isStrip = (el: Element) => el.getAttribute('role') === 'tablist';
  Object.defineProperty(proto, 'scrollWidth', { configurable: true, get() { return isStrip(this) ? TAB * VALUES.length : 0; } });
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get() { return isStrip(this) ? STRIP : 0; } });
  Object.defineProperty(proto, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      const strip = this.closest('[role="tablist"]') as HTMLElement | null;
      if (isStrip(this) || !strip) return new DOMRect(0, 0, STRIP, 40);
      const index = [...strip.children].indexOf(this);
      return new DOMRect(index * TAB - strip.scrollLeft, 0, TAB, 40);
    },
  });
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else delete (proto as unknown as Record<string, unknown>)[key];
    }
  };
}

function mount(scrollable: boolean): HTMLElement {
  const root = render(
    <Tabs defaultValue="a">
      <TabsList scrollable={scrollable}>
        {VALUES.map((value) => <TabsTrigger key={value} value={value}>{value}</TabsTrigger>)}
      </TabsList>
    </Tabs>,
  );
  return root.querySelector('[role="tablist"]') as HTMLElement;
}

afterEach(cleanup);

describe('TabsList scrollable (#8802)', () => {
  it('scrolls the strip to keep a newly selected tab clear of the fade', async () => {
    const restore = stubGeometry();
    try {
      const strip = mount(true);
      assert.equal(strip.hasAttribute('data-scroll-strip'), true, 'the strip scrolls sideways');
      assert.equal(strip.getAttribute('data-scroll-fade'), 'end', 'at the start, the end edge hides tabs');
      assert.equal(strip.scrollLeft, 0, 'the first tab is selected and already in view');
      const last = strip.querySelector('[role="tab"]:last-child') as HTMLElement;
      mouseDown(last);
      await advance(0);
      assert.equal(last.getAttribute('data-state'), 'active', 'the last tab is selected');
      const { right } = last.getBoundingClientRect();
      assert.equal(right <= STRIP, true, `the selected tab ends inside the strip (right ${right}px of ${STRIP}px)`);
      assert.equal(strip.getAttribute('data-scroll-fade'), 'start', 'scrolled to the end, the start edge hides tabs');
    } finally {
      restore();
    }
  });

  it('clears the 2rem fade at a larger root font size (#8802 review)', async () => {
    const restore = stubGeometry();
    const root = document.documentElement;
    root.style.fontSize = '20px';
    try {
      const strip = mount(true);
      const third = strip.querySelectorAll<HTMLElement>('[role="tab"]')[2];
      mouseDown(third);
      await advance(0);
      assert.equal(third.getAttribute('data-state'), 'active', 'the third tab is selected');
      const { right } = third.getBoundingClientRect();
      // 2rem at a 20 px root is 40 px; a fixed 32 px would leave 8 px under it.
      assert.equal(right <= STRIP - 40, true, `the selected tab ends clear of the 40px fade (right ${right}px of ${STRIP}px)`);
    } finally {
      root.style.fontSize = '';
      restore();
    }
  });

  it('leaves a plain tab list alone', async () => {
    const restore = stubGeometry();
    try {
      const strip = mount(false);
      await advance(0);
      assert.equal(strip.hasAttribute('data-scroll-strip'), false);
      assert.equal(strip.hasAttribute('data-scroll-fade'), false);
      assert.equal(strip.scrollLeft, 0);
    } finally {
      restore();
    }
  });
});
