/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import { createDockSlice } from '@/store/slices/dockSlice';
import { loadBottomStripTabs, persistBottomStripTabs } from './bottom-strip-persistence';

const warn = console.warn;
let warnings: unknown[][] = [];
beforeEach(() => { warnings = []; console.warn = (...args: unknown[]) => { warnings.push(args); }; });
afterEach(() => { console.warn = warn; localStorage.clear(); });

for (const replacement of [null, 'not-json', '{}']) {
  test(`#6927 bottom strip reload forgets removed unknown tabs (${replacement})`, () => {
    const key = 'ifc-lite:bottom-strip-tabs-v1';
    localStorage.setItem(key, JSON.stringify(['flow', 'future-panel']));
    assert.deepEqual(loadBottomStripTabs(), ['flow']);
    persistBottomStripTabs(['flow']);
    assert.ok(JSON.parse(localStorage.getItem(key)!).includes('future-panel'));
    if (replacement === null) localStorage.removeItem(key);
    else localStorage.setItem(key, replacement);
    assert.deepEqual(loadBottomStripTabs(), []);
    persistBottomStripTabs(['script']);
    assert.deepEqual(JSON.parse(localStorage.getItem(key)!), ['script']);
    assert.equal(warnings.length, replacement === 'not-json' ? 1 : 0);
  });

  test(`#6927 floating reload forgets removed unknown placements (${replacement})`, () => {
    const key = 'ifc-lite:dock-layout-v1';
    localStorage.setItem(key, JSON.stringify([{ id: 'future-panel', x: 20, y: 30, w: 400, h: 300, snap: 'free' }]));
    const first = createStore(createDockSlice);
    first.getState().floatPanel('clash');
    assert.ok(JSON.parse(localStorage.getItem(key)!).some((entry: { id: string }) => entry.id === 'future-panel'));
    if (replacement === null) localStorage.removeItem(key);
    else localStorage.setItem(key, replacement);
    const reloaded = createStore(createDockSlice);
    reloaded.getState().floatPanel('bcf');
    assert.deepEqual(JSON.parse(localStorage.getItem(key)!).map((entry: { id: string }) => entry.id), ['bcf']);
    assert.equal(warnings.length, replacement === 'not-json' ? 1 : 0);
  });
}
