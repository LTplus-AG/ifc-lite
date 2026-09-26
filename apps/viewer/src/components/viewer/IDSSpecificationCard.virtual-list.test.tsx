/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { EntityResult, SpecificationResult } from '@ifc-lite/ids';
import { installLayout } from '@/test/dom-layout.js';
import { cleanup, click, render } from '@/test/render.js';
import { SpecificationCard } from './IDSSpecificationCard.js';

const restoreLayout = installLayout();
// The shared layout stub gives every element an 800px box. Entity rows are
// roughly 60px tall; report that size for measured rows so scrolling through
// 250 entries has the same range it does in the browser.
const getBoundingClientRect = Element.prototype.getBoundingClientRect;
Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
  configurable: true,
  value(this: Element) {
    const rect = getBoundingClientRect.call(this);
    if (!this.hasAttribute('data-index')) return rect;
    return { ...rect, height: 60, bottom: rect.top + 60 } as DOMRect;
  },
});
const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get(this: HTMLElement) {
    if (this.hasAttribute('data-index')) return 60;
    return offsetHeightDescriptor?.get?.call(this) ?? 0;
  },
});
// happy-dom's native observer can deliver a later zero-size entry after the
// shared stub's immediate one. Measured virtual rows then collapse to 0px.
// Keep this test's observer tied to the same synthetic rectangles throughout.
class MeasuredResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    const rect = target.getBoundingClientRect();
    const box = { inlineSize: rect.width, blockSize: rect.height };
    this.callback([{
      target,
      contentRect: rect,
      borderBoxSize: [box],
      contentBoxSize: [box],
      devicePixelContentBoxSize: [box],
    }], this);
  }
  unobserve(): void {}
  disconnect(): void {}
}
Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: MeasuredResizeObserver });
Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: MeasuredResizeObserver });
after(() => {
  if (offsetHeightDescriptor) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeightDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
  restoreLayout();
});

function result(modelCount: 1 | 2): SpecificationResult {
  const entityResults: EntityResult[] = Array.from({ length: 250 }, (_, index) => ({
    modelId: modelCount === 1 || index < 125 ? 'model-a' : 'model-b',
    expressId: modelCount === 1 || index < 125 ? index + 1 : index - 124,
    entityType: 'IfcWall',
    entityName: `Wall ${index + 1}`,
    passed: false,
    requirementResults: [],
  }));
  return {
    specification: { id: 'spec-1', name: 'Wall requirements' },
    status: 'fail',
    applicableCount: entityResults.length,
    passedCount: 0,
    failedCount: entityResults.length,
    passRate: 0,
    entityResults,
  };
}

function entityButton(container: HTMLElement, name: string): HTMLButtonElement | null {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.getAttribute('aria-label')?.startsWith(`${name} -`)) ?? null;
}

afterEach(() => cleanup());

describe('IDS entity results beyond the old 100-row cap (#5830)', () => {
  for (const modelCount of [1, 2] as const) {
    it(`scrolls to and focuses entity 200 with ${modelCount} model(s)`, () => {
      const focused: Array<[string, number]> = [];
      const ui = render(
        <SpecificationCard
          result={result(modelCount)}
          isActive={false}
          onSelect={() => {}}
          onEntityClick={(modelId, expressId) => focused.push([modelId, expressId])}
          onIsolateSet={() => {}}
          filterMode="failed"
        />,
      );
      click(ui.querySelector('button')!); // Expand the specification.

      const scroller = ui.querySelector<HTMLElement>('[data-ids-entity-results]');
      assert.ok(scroller, 'expanding the specification should mount its result list');
      const rendered = [...scroller.querySelectorAll('[data-index]')];
      const first = entityButton(ui, 'Wall 1');
      assert.ok(first, `the first result must be reachable; rows=${rendered.length}; firstIndex=${rendered[0]?.getAttribute('data-index')}; lastIndex=${rendered.at(-1)?.getAttribute('data-index')}; scrollTop=${scroller.scrollTop}; spacer=${scroller.firstElementChild?.getAttribute('style')}`);
      click(first);

      assert.equal(entityButton(ui, 'Wall 200'), null, 'distant rows should be virtualized');
      act(() => {
        scroller.scrollTop = 199 * 60;
        scroller.dispatchEvent(new window.Event('scroll'));
      });

      const distant = entityButton(ui, 'Wall 200');
      assert.ok(distant, 'entity 200 should render after scrolling');
      click(distant);
      assert.deepEqual(focused, [
        ['model-a', 1],
        modelCount === 1 ? ['model-a', 200] : ['model-b', 75],
      ]);
    });
  }
});
