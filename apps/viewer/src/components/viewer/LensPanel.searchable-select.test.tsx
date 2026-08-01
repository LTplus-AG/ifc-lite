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
});
