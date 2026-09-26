/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `LocationMapSearchBar`'s results dropdown (#5817): it used to be a plain
 * `position: absolute` div with no dismissal beyond the search bar's own
 * Escape handler and no outside-click handling at all. Now it's a
 * `ui/popover.tsx` Radix Popover, portalled via `usePortalContainer()`
 * (review: `LocationMap` mounts inside `PropertiesPanel`'s
 * `overflow-hidden` tab body, so a non-portalled `PopoverContent` renders
 * as a DOM descendant of that clipping ancestor and gets clipped — the
 * #1958 bug already fixed once for `SearchableSelect`). This tests the
 * dropdown directly rather than through the full `LocationMap` (which
 * needs a WebGL-capable MapLibre load to reach the search bar at all) —
 * `LocationMap.kmz.test.tsx` covers the rest of the component.
 *
 * Because the popup now portals (default target `document.body`, not
 * `container`), every assertion below reads from `document`, not from the
 * container `render()` returns.
 */

import '@/test/setup-dom.js';
import { useState } from 'react';
import { act } from 'react';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRoot, type Root } from 'react-dom/client';
import { advance, cleanup, press, render } from '@/test/render.js';
import type { GeocodeResult } from './location-map-geocode.js';
import { LocationMapSearchBar } from './location-map-search.js';

afterEach(cleanup);

const RESULTS: GeocodeResult[] = [
  { display_name: 'Berlin, Germany', lat: 52.52, lon: 13.405 },
  { display_name: 'Berlin, New Hampshire, US', lat: 44.47, lon: -71.18 },
];

function Harness({ initialResults }: { initialResults: GeocodeResult[] }) {
  const [query, setQuery] = useState('Berlin');
  const [results, setResults] = useState(initialResults);
  return (
    <LocationMapSearchBar
      query={query}
      onQueryChange={setQuery}
      results={results}
      onResultsChange={setResults}
      loading={false}
      placeholder="Search a place"
      onSelect={() => {}}
      onClose={() => setResults([])}
    />
  );
}

async function pointerDownOutside(): Promise<void> {
  await advance(0);
  act(() => {
    document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    document.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('LocationMapSearchBar results dropdown (#5817)', () => {
  it('renders the results as a popover anchored to the input', () => {
    render(<Harness initialResults={RESULTS} />);
    const rows = document.querySelectorAll('button');
    const labels = Array.from(rows).map((b) => b.textContent);
    assert.ok(labels.some((l) => l?.includes('Berlin, Germany')));
    assert.ok(labels.some((l) => l?.includes('Berlin, New Hampshire')));
  });

  it('portals the dropdown OUT of an overflow:hidden ancestor (#1958, review)', () => {
    // Mirrors `PropertiesPanel.tsx`'s tab body: a fixed-height, clipping
    // scroll container — the ancestor a non-portaled popup would be
    // clipped by, and was, before this component was portalled.
    const clipper = document.createElement('div');
    clipper.setAttribute('data-role', 'clipping-ancestor');
    clipper.style.overflow = 'hidden';
    clipper.style.height = '40px';
    document.body.appendChild(clipper);
    let root: Root | undefined;
    try {
      root = createRoot(clipper);
      act(() => {
        root!.render(<Harness initialResults={RESULTS} />);
      });
      const row = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Berlin, Germany'));
      assert.ok(row, 'a result row renders');
      assert.equal(
        clipper.contains(row),
        false,
        'the dropdown must NOT be a DOM descendant of the overflow:hidden ancestor — otherwise it gets clipped',
      );
      // Close before unmounting — leaving a Radix Popover open across an
      // abrupt unmount skips its own closing lifecycle (floating-ui's
      // `autoUpdate` teardown included).
      const input = clipper.querySelector('input')!;
      press(input, 'Escape');
    } finally {
      if (root) act(() => root!.unmount());
      clipper.remove();
    }
  });

  it('Esc closes the dropdown without moving focus off the input', () => {
    const container = render(<Harness initialResults={RESULTS} />);
    const input = container.querySelector('input')!;
    act(() => input.focus());
    assert.match(document.body.textContent ?? '', /Berlin, Germany/);

    press(input, 'Escape');

    assert.doesNotMatch(document.body.textContent ?? '', /Berlin, Germany/);
    assert.equal(document.activeElement, input, 'focus stays on the input');
  });

  it('an outside click closes the dropdown without moving focus off the input', async () => {
    const container = render(<Harness initialResults={RESULTS} />);
    const input = container.querySelector('input')!;
    act(() => input.focus());
    assert.match(document.body.textContent ?? '', /Berlin, Germany/);

    await pointerDownOutside();

    assert.doesNotMatch(document.body.textContent ?? '', /Berlin, Germany/);
    assert.equal(document.activeElement, input, 'focus stays on the input');
  });

  it('keeps results open when the anchored input is clicked (#6110 review)', async () => {
    const container = render(<Harness initialResults={RESULTS} />);
    const input = container.querySelector('input')!;
    await advance(0);

    act(() => {
      input.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    });

    assert.match(document.body.textContent ?? '', /Berlin, Germany/);
  });
});
