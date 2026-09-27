/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rendering test for `SearchableSelect`'s popup (#1924, #5817).
 *
 * External report: "some pull-downs are transparent, but not all" — the
 * `AutoColorEditor`'s Name field (a `SearchableSelect`) sits inside nested
 * `overflow-hidden`/`overflow-auto` ancestors (the lens list scroll
 * container, the floating-panel chrome, the docked-panel host) that clip
 * its `absolute`-positioned popup and let the panel's own Save/Cancel
 * buttons paint over the (clipped) list rows. See `SearchableSelect.tsx`
 * (used from `LensPanel.tsx`'s `AutoColorEditor` and others) for the full
 * writeup, and its header comment for what #5817 changed.
 *
 * #5817 replaced the hand-rolled `createPortal` + `getBoundingClientRect`
 * flip/clamp math with Radix's `Popover` (`ui/popover.tsx`). The popped-out
 * panel window (#1208) tests this file used to carry — stubbing a trigger
 * element's `ownerDocument`/`defaultView` to a plain fake object with only
 * `innerHeight`/`addEventListener` — no longer model the real mechanism:
 * floating-ui (which `PopoverContent` is built on) reads the anchor's REAL
 * `ownerDocument.defaultView` and calls real window methods on it
 * (`getComputedStyle`, `ResizeObserver`, `requestAnimationFrame` for
 * `autoUpdate`), which a plain stub object doesn't implement — and in
 * production, a popped-out panel's trigger genuinely lives in that child
 * window's real document (`PanelWindowChrome` mounts a separate React root
 * there), so there is no bespoke code left to test in isolation; the flip
 * behavior against whichever window the anchor really lives in is Radix's
 * job, and the portal TARGET is `usePortalContainer()` — the exact same
 * app-standard context `ui/dialog.tsx`/`ui/dropdown-menu.tsx` already rely
 * on for the identical popped-out-window case. That context mechanism is
 * what this file tests instead, in the last two cases below.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PortalContainerProvider } from '@/components/ui/portal-container';
import { SearchableSelect } from './SearchableSelect.js';

const mounted: Array<{ root: Root; container: HTMLElement; trigger: HTMLButtonElement }> = [];

/** Mounts `SearchableSelect` inside a clipping ancestor, mimicking the real
 *  panel's scroll container / floating-panel chrome nesting (mimicking
 *  `LensPanel.tsx`, where `SearchableSelect` is actually used). */
function renderInClippingAncestor(props: {
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
  portalContainer?: HTMLElement | null;
}): { clipper: HTMLElement; trigger: HTMLButtonElement } {
  const clipper = document.createElement('div');
  clipper.setAttribute('data-role', 'clipping-ancestor');
  // Mirrors LensPanel.tsx's usage: scroll container / FloatingPanel chrome, fixed,
  // short, and clipping — the ancestor a non-portaled absolute popup would
  // be clipped by.
  clipper.style.overflow = 'hidden';
  clipper.style.height = '40px';
  document.body.appendChild(clipper);

  const select = (
    <SearchableSelect value={props.value} options={props.options} onChange={props.onChange} />
  );
  const root = createRoot(clipper);
  act(() => {
    root.render(
      props.portalContainer !== undefined
        ? <PortalContainerProvider container={props.portalContainer}>{select}</PortalContainerProvider>
        : select,
    );
  });
  const trigger = clipper.querySelector('button');
  assert.ok(trigger, 'trigger button must render');
  mounted.push({ root, container: clipper, trigger });
  return { clipper, trigger: trigger as HTMLButtonElement };
}

function openPopup(trigger: HTMLButtonElement): void {
  act(() => {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/**
 * Radix's outside-dismiss listens for `pointerdown` (not `click`/
 * `mousedown`, `@radix-ui/react-dismissable-layer`) and defers the actual
 * dismissal to the trailing `click` for a left-button press — the real
 * two-event sequence one physical click fires. The listener itself is
 * attached from a `setTimeout(0)` on mount (so the click that OPENED the
 * popover is never mistaken for one that should close it) — dispatching
 * synchronously, before that timer fires, makes both events silently
 * no-op (nothing attached yet), leaving the popup open. See
 * `ui/popover.test.tsx` for the same pattern against the wrapper directly.
 */
async function pointerDownOutside(target: EventTarget): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  act(() => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function findPopupIn(doc: Document): HTMLElement | null {
  return doc.body.querySelector('[data-testid="searchable-select-popup"]');
}

function findPopupInDocument(): HTMLElement | null {
  return findPopupIn(document);
}

afterEach(() => {
  // A failed assertion must still close the popup before the next test
  // unmounts its root; an open Radix portal leaves autoUpdate running.
  const active = mounted.at(-1);
  if (active && findPopupInDocument()) openPopup(active.trigger);
});

describe('SearchableSelect popup portal (#1924, #5817)', () => {
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
    // The popup's DIRECT parent is Radix's own floating-ui positioning
    // wrapper (`[data-radix-popper-content-wrapper]`), not `<body>` itself
    // — that wrapper is what's actually appended to the portal target.
    assert.equal(document.body.contains(popup), true, 'popup portals under <body> by default');
    assert.ok(
      popup?.closest('[data-radix-popper-content-wrapper]')?.parentElement === document.body,
      'the Radix positioning wrapper is portaled under <body>',
    );

    openPopup(trigger); // close before the root unmounts, see the portal-container test's note
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
    // A row picked by mousedown+click (the real two-event gesture) — Radix's
    // own DismissableLayer, not a hand-rolled containment guard, is what
    // keeps a click inside the popup from unmounting it before the row's
    // own `click` fires.
    act(() => {
      wallRow?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    act(() => {
      wallRow?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    assert.equal(picked, 'IfcWall');
    assert.equal(findPopupInDocument(), null, 'popup closes after picking a value');
  });

  it('closes on outside click even though the popup is portaled away from the trigger container', async () => {
    const { trigger } = renderInClippingAncestor({
      value: '',
      options: ['Alpha', 'Beta'],
      onChange: () => {},
    });

    openPopup(trigger);
    assert.ok(findPopupInDocument(), 'popup open');

    await pointerDownOutside(document.body);

    assert.equal(findPopupInDocument(), null, 'outside click closes the portaled popup');
  });

  it('portals into whatever container usePortalContainer() provides (#1208, via PortalContainerProvider) instead of the default <body>', () => {
    // A real, ATTACHED element in the SAME live document — not a fully
    // detached `document.implementation.createHTMLDocument()` standing in
    // for a popped-out window's real document. Radix's `Popover.Content`
    // is built on floating-ui's `autoUpdate`, which calls real window/
    // `ResizeObserver` machinery on whatever it's portaled into; a fully
    // detached document (attached to no window) starved that loop and
    // OOM-crashed the test runner rather than failing an assertion — the
    // exact "no bespoke code left to test in isolation" gap this file's
    // header comment describes. What's testable, and what this component
    // actually owns, is that `usePortalContainer()`'s value reaches
    // `PopoverPortal`'s `container` prop; a real cross-window portal target
    // is `ui/dialog.tsx`/`ui/dropdown-menu.tsx`'s (and `PanelWindowChrome`'s)
    // territory, already exercised there.
    const otherContainer = document.createElement('div');
    otherContainer.setAttribute('data-role', 'other-portal-target');
    document.body.appendChild(otherContainer);
    const { trigger } = renderInClippingAncestor({
      value: '',
      options: ['Alpha', 'Beta'],
      onChange: () => {},
      portalContainer: otherContainer,
    });
    try {
      openPopup(trigger);

      assert.ok(otherContainer.querySelector('[data-testid="searchable-select-popup"]'), 'popup portals into the provided container');
      // Exactly one popup exists anywhere in the document, and it's already
      // shown to be inside `otherContainer` — so it did not ALSO land under
      // the default target (`<body>`, outside `otherContainer`).
      assert.equal(document.querySelectorAll('[data-testid="searchable-select-popup"]').length, 1);
    } finally {
      // Close before unmounting (the next `beforeEach` unmounts this test's
      // root): leaving Radix's `Popover` mid-open when its root unmounts
      // skips its own closing lifecycle (floating-ui's `autoUpdate`
      // teardown included), which is exactly the dangling-resources shape
      // that OOM-crashed this file before every test below was made to
      // close explicitly.
      openPopup(trigger);
      otherContainer.remove();
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
 * - The clipping and portal tests above assert position and behaviour, not
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

    openPopup(trigger); // close before the root unmounts, see the portal-container test's note
  });
});
