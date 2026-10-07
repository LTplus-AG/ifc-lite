/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import { createDockSlice } from '@/store/slices/dockSlice';
import { loadBottomStripTabs, persistBottomStripTabs } from './bottom-strip-persistence';

afterEach(() => localStorage.clear());

test('#7054 removing persisted tabs cannot resurrect a previously preserved unknown tab', () => {
  const key = 'ifc-lite:bottom-strip-tabs-v1';
  localStorage.setItem(key, JSON.stringify(['drawing', 'future:tab']));
  assert.deepEqual(loadBottomStripTabs(), ['drawing']);
  localStorage.removeItem(key);
  assert.deepEqual(loadBottomStripTabs(), []);
  persistBottomStripTabs(['drawing']);
  assert.deepEqual(JSON.parse(localStorage.getItem(key)!), ['drawing']);
});

test('#7054 removing persisted floats cannot resurrect a previously preserved unknown panel', () => {
  const key = 'ifc-lite:dock-layout-v1';
  localStorage.setItem(key, JSON.stringify([{ id: 'future:panel', snap: 'free', x: 20, y: 30, w: 360, h: 460 }]));
  const loaded = createStore(createDockSlice);
  assert.deepEqual(loaded.getState().floatingPanels, []);
  loaded.getState().floatPanel('properties');
  assert.ok(JSON.parse(localStorage.getItem(key)!).some((panel: { id: string }) => panel.id === 'future:panel'));
  localStorage.removeItem(key);
  const reloaded = createStore(createDockSlice);
  reloaded.getState().floatPanel('clash');
  assert.deepEqual(JSON.parse(localStorage.getItem(key)!).map((panel: { id: string }) => panel.id), ['clash']);
});
