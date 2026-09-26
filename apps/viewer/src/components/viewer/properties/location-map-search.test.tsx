/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `LocationMapSearchBar`'s results dropdown (#5817): it used to be a plain
 * `position: absolute` div with no dismissal beyond the search bar's own
 * Escape handler and no outside-click handling at all. Now it's a
 * `ui/popover.tsx` Radix Popover. This tests the dropdown directly rather
 * than through the full `LocationMap` (which needs a WebGL-capable MapLibre
 * load to reach the search bar at all) — `LocationMap.kmz.test.tsx` covers
 * the rest of the component.
 */

import '@/test/setup-dom.js';
import { useState } from 'react';
import { act } from 'react';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
    const container = render(<Harness initialResults={RESULTS} />);
    const rows = container.querySelectorAll('button');
    const labels = Array.from(rows).map((b) => b.textContent);
    assert.ok(labels.some((l) => l?.includes('Berlin, Germany')));
    assert.ok(labels.some((l) => l?.includes('Berlin, New Hampshire')));
  });

  it('Esc closes the dropdown without moving focus off the input', () => {
    const container = render(<Harness initialResults={RESULTS} />);
    const input = container.querySelector('input')!;
    act(() => input.focus());
    assert.match(container.textContent ?? '', /Berlin, Germany/);

    press(input, 'Escape');

    assert.doesNotMatch(container.textContent ?? '', /Berlin, Germany/);
    assert.equal(document.activeElement, input, 'focus stays on the input');
  });

  it('an outside click closes the dropdown without moving focus off the input', async () => {
    const container = render(<Harness initialResults={RESULTS} />);
    const input = container.querySelector('input')!;
    act(() => input.focus());
    assert.match(container.textContent ?? '', /Berlin, Germany/);

    await pointerDownOutside();

    assert.doesNotMatch(container.textContent ?? '', /Berlin, Germany/);
    assert.equal(document.activeElement, input, 'focus stays on the input');
  });
});
