/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  createStreamingViewerAdapter,
  createStreamingVisibilityAdapter,
} from '../src/streaming-viewer.js';

type Call = { url: string; body: Record<string, unknown> };

let calls: Call[];
let originalFetch: typeof fetch;

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const ref = (id: number) => ({ expressId: id }) as any;

describe('createStreamingViewerAdapter', () => {
  it('colorize posts colorizeEntities with mapped ids and color', () => {
    const adapter = createStreamingViewerAdapter(4321);
    adapter.colorize([ref(1), ref(2)], [1, 0, 0, 1]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://localhost:4321/api/command');
    assert.deepEqual(calls[0].body, { action: 'colorizeEntities', ids: [1, 2], color: [1, 0, 0, 1] });
  });

  it('colorizeAll sends one command per batch', () => {
    const adapter = createStreamingViewerAdapter(4321);
    adapter.colorizeAll([
      { refs: [ref(1)], color: [1, 0, 0, 1] },
      { refs: [ref(2), ref(3)], color: [0, 1, 0, 1] },
    ]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body, { action: 'colorizeEntities', ids: [1], color: [1, 0, 0, 1] });
    assert.deepEqual(calls[1].body, { action: 'colorizeEntities', ids: [2, 3], color: [0, 1, 0, 1] });
  });

  it('resetColors with non-empty refs sends resetColorEntities with those ids', () => {
    const adapter = createStreamingViewerAdapter(4321);
    adapter.resetColors([ref(7), ref(8)]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { action: 'resetColorEntities', ids: [7, 8] });
  });

  it('resetColors with no refs sends showall', () => {
    const adapter = createStreamingViewerAdapter(4321);
    adapter.resetColors();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { action: 'showall' });
  });

  it('resetColors with an empty refs array sends showall, not resetColorEntities', () => {
    const adapter = createStreamingViewerAdapter(4321);
    adapter.resetColors([]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { action: 'showall' });
  });

  it('flyTo posts flyto with mapped ids', () => {
    const adapter = createStreamingViewerAdapter(4321);
    adapter.flyTo([ref(9)]);
    assert.deepEqual(calls[0].body, { action: 'flyto', ids: [9] });
  });

  it('setSection posts section with the section payload', () => {
    const adapter = createStreamingViewerAdapter(4321);
    adapter.setSection({ plane: 'x' });
    assert.deepEqual(calls[0].body, { action: 'section', section: { plane: 'x' } });
  });

  it('getSection returns null', () => {
    const adapter = createStreamingViewerAdapter(4321);
    assert.equal(adapter.getSection(), null);
  });

  it('setCamera posts camera with the state payload', () => {
    const adapter = createStreamingViewerAdapter(4321);
    adapter.setCamera({ pos: [0, 0, 1] });
    assert.deepEqual(calls[0].body, { action: 'camera', state: { pos: [0, 0, 1] } });
  });

  it('getCamera returns a perspective mode stub', () => {
    const adapter = createStreamingViewerAdapter(4321);
    assert.deepEqual(adapter.getCamera(), { mode: 'perspective' });
  });
});

describe('createStreamingVisibilityAdapter', () => {
  it('hide posts hideEntities with mapped ids', () => {
    const adapter = createStreamingVisibilityAdapter(4321);
    adapter.hide([ref(1), ref(2)]);
    assert.deepEqual(calls[0].body, { action: 'hideEntities', ids: [1, 2] });
  });

  it('show posts showEntities with mapped ids', () => {
    const adapter = createStreamingVisibilityAdapter(4321);
    adapter.show([ref(3)]);
    assert.deepEqual(calls[0].body, { action: 'showEntities', ids: [3] });
  });

  it('isolate posts isolateEntities with mapped ids', () => {
    const adapter = createStreamingVisibilityAdapter(4321);
    adapter.isolate([ref(4)]);
    assert.deepEqual(calls[0].body, { action: 'isolateEntities', ids: [4] });
  });

  it('reset posts showall', () => {
    const adapter = createStreamingVisibilityAdapter(4321);
    adapter.reset();
    assert.deepEqual(calls[0].body, { action: 'showall' });
  });
});
