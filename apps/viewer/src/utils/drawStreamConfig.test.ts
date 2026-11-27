/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DRAW_STREAM_CONFIG } from '@ifc-lite/renderer';
import { configureDrawStream, getDrawStreamConfig } from './drawStreamConfig.js';
import type { DrawStreamConfig } from '@ifc-lite/renderer';

const g = globalThis as Record<string, unknown>;

function setSearch(search: string): void {
  Object.defineProperty(globalThis, 'location', { value: { search }, configurable: true, writable: true });
}

afterEach(() => {
  delete g.__IFC_LITE_M6__;
  Reflect.deleteProperty(globalThis, 'location');
});

describe('draw stream config', () => {
  it('is off with no flag set', () => {
    const config = getDrawStreamConfig();
    assert.deepEqual(config, { ...DEFAULT_DRAW_STREAM_CONFIG });
    const applied: DrawStreamConfig[] = [];
    assert.equal(configureDrawStream({ setDrawStreamConfig: (c) => applied.push(c) }), false);
    assert.deepEqual(applied, [], 'the renderer is left untouched');
  });

  it('reads one m6.<key> URL param per key', () => {
    setSearch('?m6.stream=1&m6.hlod=1&m6.hlodPx=3&m6.bundles=0');
    const config = getDrawStreamConfig();
    assert.deepEqual([config.stream, config.hlod, config.hlodPx, config.bundles, config.arena], [true, true, 3, false, false]);
    const applied: DrawStreamConfig[] = [];
    assert.equal(configureDrawStream({ setDrawStreamConfig: (c) => applied.push(c) }), true);
    assert.deepEqual(applied, [config]);
  });

  it('takes an object global, whose keys beat their URL params', () => {
    setSearch('?m6.stream=0&m6.arena=1');
    g.__IFC_LITE_M6__ = { stream: '1', hlIndex: true };
    const config = getDrawStreamConfig();
    assert.deepEqual([config.stream, config.hlIndex, config.arena], [true, true, true]);
  });

  it('treats a scalar global as the stream switch', () => {
    g.__IFC_LITE_M6__ = 1;
    assert.equal(getDrawStreamConfig().stream, true);
  });

  it('never switches a path on from a malformed value', () => {
    setSearch('?m6.stream=yes&m6.hlodPx=-1');
    const config = getDrawStreamConfig();
    assert.deepEqual([config.stream, config.hlodPx], [false, DEFAULT_DRAW_STREAM_CONFIG.hlodPx]);
  });
});
