/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two teardown halves of the Location panel's map lifecycle.
 *
 * Both exist because MapLibre fails messily. `disposeMap` must contain a throw
 * from `map.remove()` — a map whose WebGL context died mid-life throws there,
 * and letting that escape would take down the effect cleanup that called it,
 * stranding the panel. `purgeMapContainer` must undo what MapLibre's
 * `_setupContainer` did to our div BEFORE the context was requested, since both
 * failure paths leave that debris behind with `mapRef` never assigned — out of
 * reach of the unmount cleanup, so the fallback UI would render around a dead
 * canvas.
 *
 * `loadMaplibre` is not covered here: it is a memoised dynamic `import()` of
 * the real module, and faking that is testing the mock.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import '@/test/setup-dom.js';
import { disposeMap, purgeMapContainer } from './location-map-lifecycle.js';

type MapLike = Parameters<typeof disposeMap>[0];

describe('disposeMap', () => {
  it('removes the map', () => {
    let removed = 0;
    disposeMap({ remove() { removed++; } } as unknown as MapLike);

    assert.equal(removed, 1);
  });

  it('contains a throw from remove(), so a dead context cannot break the cleanup', () => {
    const exploding = {
      remove() { throw new Error('WebGL context lost during teardown'); },
    } as unknown as MapLike;

    // The caller is a React effect cleanup — a throw here would leave the
    // panel in a half-torn-down state.
    assert.doesNotThrow(() => disposeMap(exploding));
  });
});

describe('purgeMapContainer', () => {
  it('removes the children MapLibre built before the context was requested', () => {
    const container = document.createElement('div');
    container.classList.add('maplibregl-map');
    container.appendChild(document.createElement('canvas'));
    container.appendChild(document.createElement('div'));

    purgeMapContainer(container);

    assert.equal(container.childElementCount, 0, 'a dead canvas must not survive');
  });

  it('drops the maplibregl-map class, so the fallback UI is not styled as a map', () => {
    const container = document.createElement('div');
    container.classList.add('maplibregl-map', 'rounded-md');

    purgeMapContainer(container);

    assert.equal(container.classList.contains('maplibregl-map'), false);
    assert.equal(container.classList.contains('rounded-md'), true, 'our own classes stay');
  });

  it('is a no-op on a container MapLibre never touched', () => {
    const container = document.createElement('div');

    assert.doesNotThrow(() => purgeMapContainer(container));
    assert.equal(container.childElementCount, 0);
  });
});
