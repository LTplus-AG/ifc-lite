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
 * buttons paint over the (clipped) list rows. See `SearchableSelect.tsx`
 * (used from `LensPanel.tsx`'s `AutoColorEditor` and others) for the full writeup.
 *
 * The fix portals the popup to the trigger's OWN document's `<body>` (a
 * panel popped out into its own OS / PiP window, #1208, renders the trigger
 * in a document that isn't the main tab's, see `resolveTriggerDocument` in
 * `SearchableSelect.tsx`) with `position: fixed` coordinates from the trigger's
 * `getBoundingClientRect()`, so it renders OUTSIDE the clipping ancestors.
 * This test reproduces the clipping ancestor and asserts the open popup is
 * not a DOM descendant of it — this assertion FAILS against the pre-fix
 * implementation, where the popup was `absolute`-positioned inside the same
 * clipped container (verified by reverting the portal and re-running: see
 * PR discussion).
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SearchableSelect } from './SearchableSelect.js';

/** Records `addEventListener`/`removeEventListener` calls made on a fake
 *  "other window" object, so a test can assert listeners land on the
 *  trigger's own window rather than the global `window` (#1958 follow-up:
 *  right portal target, wrong coordinate space — see SearchableSelect.tsx's
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

/** Creates a real, detached `Document` (via
 *  `document.implementation.createHTMLDocument`) standing in for a
 *  popped-out panel window's document (#1208). It has to be a REAL document
 *  — not a plain stub object like `createFakeTriggerWindow`'s — because
 *  `SearchableSelect` portals its popup into `<body>` via `createPortal`,
 *  which needs an actual DOM node to mount into, and because the
 *  outside-click listener needs a real `addEventListener`/dispatch path. */
function createFakeTriggerDocument(): Document {
  return document.implementation.createHTMLDocument('popped-out-panel');
}

/** Makes `el.ownerDocument` resolve to a fake document standing in for a
 *  popped-out panel window's document (#1208), and — when `fakeWindow` is
 *  given — makes that fake document's `defaultView` resolve to `fakeWindow`
 *  too (`resolveTriggerWindow` reads `ownerDocument.defaultView`, so the two
 *  must agree: a trigger living in another document lives in that
 *  document's window, never a mix of one real and one fake). Shadows only
 *  this element's own `ownerDocument` property, leaving the real global
 *  `document`/`window` (and every other node in the test) untouched.
 *  Returns the fake document so tests can assert against it directly. */
function stubOwnerWindow(el: HTMLElement, fakeWindow?: unknown): Document {
  const fakeDocument = createFakeTriggerDocument();
  if (fakeWindow !== undefined) {
    Object.defineProperty(fakeDocument, 'defaultView', {
      value: fakeWindow,
      configurable: true,
    });
  }
  Object.defineProperty(el, 'ownerDocument', {
    value: fakeDocument,
    configurable: true,
  });
  return fakeDocument;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

/** Mounts `SearchableSelect` inside a clipping ancestor, mimicking the real
 *  panel's scroll container / floating-panel chrome nesting (mimicking
 *  `LensPanel.tsx`, where `SearchableSelect` is actually used). */
function renderInClippingAncestor(props: {
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}): { clipper: HTMLElement; trigger: HTMLButtonElement } {
  const clipper = document.createElement('div');
  clipper.setAttribute('data-role', 'clipping-ancestor');
  // Mirrors LensPanel.tsx's usage: scroll container / FloatingPanel chrome, fixed,
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

function findPopupIn(doc: Document): HTMLElement | null {
  return doc.body.querySelector('[data-testid="searchable-select-popup"]');
}

function findPopupInDocument(): HTMLElement | null {
  return findPopupIn(document);
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
    // Dispatch the real user gesture — mousedown THEN click — not click
    // alone. A bare click never exercises the outside-click handler's
    // `popupRef.current?.contains(target)` guard (SearchableSelect.tsx),
    // since that guard runs on `mousedown`; skipping the mousedown here
    // let this test pass even with the guard deleted (#1958 review). With
    // the mousedown included: the doc-level mousedown handler sees the
    // click target as inside the popup and does NOT close it, so the
    // option row is still mounted when its `click` fires afterward.
    //
    // Each dispatch gets its OWN `act()` call — a real browser delivers
    // mousedown and click as two separate native events, and React flushes
    // the state update (and the resulting unmount, if the guard were gone)
    // from the first before the second ever fires. A single `act()`
    // wrapping both dispatches lets React batch them together and defer the
    // unmount until after the click has already been dispatched, which
    // would hide the very regression this test exists to catch.
    act(() => {
      wallRow?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
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

  it('portals the popup into the trigger\'s own document, not the global one (#1958 follow-up: document layer)', () => {
    const { trigger } = renderInClippingAncestor({
      value: '',
      options: ['Alpha', 'Beta'],
      onChange: () => {},
    });
    // No fakeWindow needed here — only the owning-document resolution is
    // under test (the portal target), not the flip/viewport math.
    const fakeDocument = stubOwnerWindow(trigger);

    openPopup(trigger);

    assert.ok(findPopupIn(fakeDocument), 'popup portals into the trigger\'s own document\'s body');
    assert.equal(findPopupInDocument(), null, 'popup must NOT land in the main tab\'s document');
  });

  it('attaches and removes the outside-click listener on the trigger\'s own document, not the global one (#1958 follow-up: document layer)', () => {
    const { trigger } = renderInClippingAncestor({
      value: '',
      options: ['Alpha', 'Beta'],
      onChange: () => {},
    });
    const fakeDocument = stubOwnerWindow(trigger);

    openPopup(trigger);
    assert.ok(findPopupIn(fakeDocument), 'popup open, portaled into the trigger\'s own document');

    // A mousedown in the MAIN TAB's document must NOT close a popup whose
    // trigger lives in a different (popped-out panel) document — the
    // listener was never attached there.
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    assert.ok(findPopupIn(fakeDocument), 'popup stays open: outside click in the wrong (global) document is ignored');

    // A mousedown in the trigger's OWN document closes it.
    act(() => {
      fakeDocument.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    assert.equal(findPopupIn(fakeDocument), null, 'outside click in the trigger\'s own document closes the popup');
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
    const fakeDocument = stubOwnerWindow(trigger, fakeWindow);

    openPopup(trigger);

    // The popup portals into the trigger's OWN document now (#1958
    // follow-up), so it must be looked up there, not in the global document.
    const popup = findPopupIn(fakeDocument);
    assert.ok(popup, 'popup renders when open');
    assert.equal(findPopupInDocument(), null, 'popup does not leak into the global document');
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
    const fakeDocument = stubOwnerWindow(trigger, fakeWindow);

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
      // The outside-click listener itself lives on the trigger's own
      // document (#1958 follow-up), so the closing click must be dispatched
      // there, not on the global document.
      act(() => {
        fakeDocument.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
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

/**
 * `popover-surface` is what keeps this popup opaque in the `.colorful` theme
 * (#1972). It is easy to lose and nothing else notices:
 *
 * - `colorful-popover-opacity.test.ts` asserts the CSS *rules* exist and are
 *   ordered correctly — it never renders a component, so it stays green when
 *   the class is absent from the markup.
 * - The clipping and anchor tests here assert position and behaviour, not
 *   class names.
 *
 * It went missing exactly once already: #1972 added the class to the popup in
 * `LensPanel.tsx` while this branch was moving that element into
 * `SearchableSelect.tsx`, so the merge took this file's copy and dropped the
 * marker without a conflict on that line. Losing it re-opens #1924 silently,
 * because `.colorful .bg-white` reclaims the popup at 48% alpha.
 */
describe('SearchableSelect popup keeps the colorful-theme opacity marker (#1972)', () => {
  it('renders the popup with the popover-surface class', () => {
    const { trigger } = renderInClippingAncestor({
      value: '',
      options: ['Alpha', 'Beta', 'Gamma'],
      onChange: () => {},
    });
    openPopup(trigger);

    const popup = findPopupInDocument();
    assert.ok(popup, 'popup should be open');
    assert.ok(
      popup!.classList.contains('popover-surface'),
      `popup must carry "popover-surface" or it turns translucent in the colorful theme (#1924); got "${popup!.className}"`,
    );
  });
});
