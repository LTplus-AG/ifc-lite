/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rendering test for `SearchableSelect`'s popup portal (#1924).
 *
 * External report: "some pull-downs are transparent, but not all" — the
 * `AutoColorEditor`'s Name field (a `SearchableSelect`) sits inside nested
 * `overflow-hidden`/`overflow-auto` ancestors (the lens list scroll
 * container, the floating-panel chrome, the docked-panel host) that clip
 * its `absolute`-positioned popup and let the panel's own Save/Cancel
 * buttons paint over the (clipped) list rows. See `LensPanel.tsx` around
 * `AutoColorEditor` / `SearchableSelect` for the full writeup.
 *
 * The fix portals the popup to `document.body` (or the popped-out panel
 * window's body, #1208) with `position: fixed` coordinates from the
 * trigger's `getBoundingClientRect()`, so it renders OUTSIDE the clipping
 * ancestors. This test reproduces the clipping ancestor and asserts the
 * open popup is not a DOM descendant of it — this assertion FAILS against
 * the pre-fix implementation, where the popup was `absolute`-positioned
 * inside the same clipped container (verified by reverting the portal and
 * re-running: see PR discussion).
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SearchableSelect } from './LensPanel.js';

/** Records `addEventListener`/`removeEventListener` calls made on a fake
 *  "other window" object, so a test can assert listeners land on the
 *  trigger's own window rather than the global `window` (#1958 follow-up:
 *  right portal target, wrong coordinate space — see LensPanel.tsx's
 *  `resolveTriggerWindow`). */
function createFakeTriggerWindow(innerHeight: number) {
  const calls: Array<{ method: 'add' | 'remove'; type: string }> = [];
  const fakeWindow = {
    innerHeight,
    addEventListener: (type: string) => { calls.push({ method: 'add', type }); },
    removeEventListener: (type: string) => { calls.push({ method: 'remove', type }); },
  };
  return { fakeWindow, calls };
}

/** Makes `el.ownerDocument.defaultView` resolve to `fakeWindow`, mimicking a
 *  trigger rendered in a popped-out panel window whose document belongs to a
 *  different `Window` than the main tab's global. Shadows only this
 *  element's own `ownerDocument` property, leaving the real global
 *  `document`/`window` (and every other node in the test) untouched. */
function stubOwnerWindow(el: HTMLElement, fakeWindow: unknown): void {
  Object.defineProperty(el, 'ownerDocument', {
    value: { defaultView: fakeWindow },
    configurable: true,
  });
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

/** Mounts `SearchableSelect` inside a clipping ancestor, mimicking the real
 *  `LensPanel` scroll container / floating-panel chrome nesting. */
function renderInClippingAncestor(props: {
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}): { clipper: HTMLElement; trigger: HTMLButtonElement } {
  const clipper = document.createElement('div');
  clipper.setAttribute('data-role', 'clipping-ancestor');
  // Mirrors LensPanel.tsx's scroll container / FloatingPanel chrome: fixed,
  // short, and clipping — the ancestor a non-portaled absolute popup would
  // be clipped by.
  clipper.style.overflow = 'hidden';
  clipper.style.height = '40px';
  document.body.appendChild(clipper);

  const root = createRoot(clipper);
  act(() => {
    root.render(
      <SearchableSelect value={props.value} options={props.options} onChange={props.onChange} />,
    );
  });
  mounted.push({ root, container: clipper });

  const trigger = clipper.querySelector('button');
  assert.ok(trigger, 'trigger button must render');
  return { clipper, trigger: trigger as HTMLButtonElement };
}

function openPopup(trigger: HTMLButtonElement): void {
  act(() => {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function findPopupInDocument(): HTMLElement | null {
  return document.body.querySelector('[data-testid="searchable-select-popup"]');
}

describe('SearchableSelect popup portal (#1924)', () => {
  beforeEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
    // Anything the portal left behind directly under <body>.
    for (const stray of document.body.querySelectorAll('[data-testid="searchable-select-popup"]')) {
      stray.remove();
    }
  });

  it('portals the open popup OUT of a clipping ancestor (the #1924 regression)', () => {
    const { clipper, trigger } = renderInClippingAncestor({
      value: '',
      options: ['Alpha', 'Beta', 'Gamma'],
      onChange: () => {},
    });

    openPopup(trigger);

    const popup = findPopupInDocument();
    assert.ok(popup, 'popup must render into the document when open');
    assert.equal(
      clipper.contains(popup),
      false,
      'popup must NOT be a DOM descendant of the overflow:hidden ancestor — ' +
        'otherwise it gets clipped exactly like the reported bug',
    );
    assert.equal(popup?.parentElement, document.body, 'popup portals directly to <body>');
  });

  it('still lists and filters options, and commits the picked value (behaviour must not regress)', () => {
    let picked: string | undefined;
    const { trigger } = renderInClippingAncestor({
      value: '',
      options: ['IfcWall', 'IfcWindow', 'IfcWallStandardCase', 'IfcDoor', 'IfcSlab', 'IfcBeam', 'IfcColumn', 'IfcRoof', 'IfcStair'],
      onChange: (v) => { picked = v; },
    });

    openPopup(trigger);
    const popup = findPopupInDocument();
    assert.ok(popup);

    // > 8 options triggers the filter input (see SearchableSelect).
    const filterInput = popup?.querySelector('input');
    assert.ok(filterInput, 'filter input renders for large option lists');

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(filterInput, 'wall');
      filterInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const rows = () => [...(findPopupInDocument()?.querySelectorAll('button') ?? [])];
    const matchLabels = rows().map((b) => b.textContent);
    assert.ok(matchLabels.every((t) => t?.toLowerCase().includes('wall')), `expected only "wall" matches, got ${JSON.stringify(matchLabels)}`);
    assert.equal(matchLabels.length, 2, 'IfcWall and IfcWallStandardCase both match "wall"');

    const wallRow = rows().find((b) => b.textContent === 'IfcWall');
    assert.ok(wallRow);
    act(() => {
      wallRow?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    assert.equal(picked, 'IfcWall');
    assert.equal(findPopupInDocument(), null, 'popup closes after picking a value');
  });

  it('closes on outside click even though the popup is portaled away from the trigger container', () => {
    const { trigger } = renderInClippingAncestor({
      value: '',
      options: ['Alpha', 'Beta'],
      onChange: () => {},
    });

    openPopup(trigger);
    assert.ok(findPopupInDocument(), 'popup open');

    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });

    assert.equal(findPopupInDocument(), null, 'outside click closes the portaled popup');
  });

  it('measures the flip decision against the trigger\'s own window, not the global one (#1958 follow-up)', () => {
    const { trigger } = renderInClippingAncestor({
      value: '',
      options: ['Alpha', 'Beta'],
      onChange: () => {},
    });

    // Trigger sits at y=[500, 530]. Against the real global window
    // (innerHeight 768 under happy-dom), there's 238px below — plenty of
    // room, so it should open DOWN. Against a fake "own window" only 540px
    // tall, there's just 10px below and 500px above, so it should flip UP.
    // The two windows disagree on purpose: if the component reads the
    // global instead of the trigger's own window, this assertion fails.
    Object.defineProperty(trigger, 'getBoundingClientRect', {
      value: () => ({ left: 10, width: 120, top: 500, bottom: 530, right: 130, height: 30, x: 10, y: 500, toJSON: () => ({}) }),
      configurable: true,
    });
    const { fakeWindow } = createFakeTriggerWindow(540);
    stubOwnerWindow(trigger, fakeWindow);

    openPopup(trigger);

    const popup = findPopupInDocument();
    assert.ok(popup, 'popup renders when open');
    assert.equal(popup?.style.top, '', 'flips up, so no top offset is set');
    assert.notEqual(popup?.style.bottom, '', 'flips up against the fake (short) window, anchoring from the bottom');
  });

  it('attaches and removes scroll/resize listeners on the trigger\'s own window, not the global one (#1958 follow-up)', () => {
    const { trigger } = renderInClippingAncestor({
      value: '',
      options: ['Alpha', 'Beta'],
      onChange: () => {},
    });
    Object.defineProperty(trigger, 'getBoundingClientRect', {
      value: () => ({ left: 10, width: 120, top: 500, bottom: 530, right: 130, height: 30, x: 10, y: 500, toJSON: () => ({}) }),
      configurable: true,
    });
    const { fakeWindow, calls } = createFakeTriggerWindow(540);
    stubOwnerWindow(trigger, fakeWindow);

    const globalCalls: Array<{ method: 'add' | 'remove'; type: string }> = [];
    const realAdd = window.addEventListener.bind(window);
    const realRemove = window.removeEventListener.bind(window);
    window.addEventListener = ((type: string, ...rest: [unknown, unknown?]) => {
      if (type === 'scroll' || type === 'resize') globalCalls.push({ method: 'add', type });
      return realAdd(type, ...rest as [EventListenerOrEventListenerObject, (boolean | AddEventListenerOptions)?]);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string, ...rest: [unknown, unknown?]) => {
      if (type === 'scroll' || type === 'resize') globalCalls.push({ method: 'remove', type });
      return realRemove(type, ...rest as [EventListenerOrEventListenerObject, (boolean | EventListenerOptions)?]);
    }) as typeof window.removeEventListener;

    try {
      openPopup(trigger);
      assert.ok(
        calls.some((c) => c.method === 'add' && c.type === 'scroll') &&
          calls.some((c) => c.method === 'add' && c.type === 'resize'),
        `expected scroll+resize listeners on the trigger's own window, got ${JSON.stringify(calls)}`,
      );
      assert.equal(
        globalCalls.filter((c) => c.method === 'add').length,
        0,
        `expected no scroll/resize listeners on the global window, got ${JSON.stringify(globalCalls)}`,
      );

      // Closing (outside click) must remove the listeners from the SAME
      // (trigger's own) window, not leak them or remove from the global one.
      act(() => {
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      });
      assert.ok(
        calls.some((c) => c.method === 'remove' && c.type === 'scroll') &&
          calls.some((c) => c.method === 'remove' && c.type === 'resize'),
        `expected scroll+resize listener removal on the trigger's own window, got ${JSON.stringify(calls)}`,
      );
      assert.equal(
        globalCalls.filter((c) => c.method === 'remove').length,
        0,
        `expected no scroll/resize listener removal on the global window, got ${JSON.stringify(globalCalls)}`,
      );
    } finally {
      window.addEventListener = realAdd;
      window.removeEventListener = realRemove;
    }
  });
});
