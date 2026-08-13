/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `useDebouncedValue`, split out of LocationMap.tsx and tested for the first
 * time. It is what stops the place-search firing a Nominatim request per
 * keystroke, so the behaviour that matters is that intermediate values are
 * DROPPED rather than merely delayed — a debounce that emits every value late
 * would still hammer the geocoder.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useDebouncedValue } from './useDebouncedValue.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function Probe({ value, seen }: { value: string; seen: string[] }) {
  const debounced = useDebouncedValue(value, 30);
  if (seen[seen.length - 1] !== debounced) seen.push(debounced);
  return <span>{debounced}</span>;
}

const roots: Root[] = [];

/** Mount a Probe and return a setter that re-renders it with a new value. */
async function mountProbe(seen: string[], initial: string) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => { root.render(<Probe value={initial} seen={seen} />); });
  // Three phases on purpose: `act` flushes effects when it EXITS, so the
  // debounce timer does not start until the render block closes. Sleeping in
  // the same block would run the clock before the timer existed.
  return async (value: string, waitMs: number) => {
    await act(async () => { root.render(<Probe value={value} seen={seen} />); });
    await act(async () => { await sleep(waitMs); });
    await act(async () => { await sleep(0); });
  };
}

after(async () => {
  await act(async () => { for (const r of roots) r.unmount(); });
});

describe('useDebouncedValue', () => {
  it('returns the initial value immediately', async () => {
    const seen: string[] = [];
    await mountProbe(seen, 'a');

    assert.deepEqual(seen, ['a']);
  });

  it('drops intermediate values instead of emitting each one late', async () => {
    const seen: string[] = [];
    const set = await mountProbe(seen, 'R');

    // Type "Ro", "Ros", "Rost" faster than the delay.
    for (const v of ['Ro', 'Ros', 'Rost']) await set(v, 5);
    await act(async () => { await sleep(90); });

    assert.deepEqual(seen, ['R', 'Rost'], 'only the settled value should be emitted');
  });

  it('emits a value once it holds still', async () => {
    const seen: string[] = [];
    const set = await mountProbe(seen, 'a');

    await set('b', 90);

    assert.equal(seen[seen.length - 1], 'b');
  });
});
