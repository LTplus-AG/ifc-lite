/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Drawing inspector's tab/width state (#5495): one persisted field
 * decides which of Overrides/Sheet/Underlays/Scan is open, replacing three
 * view-local `useState` flags plus the store's `sheetPanelVisible`. This
 * covers the slice in isolation (toggle semantics, width clamping,
 * localStorage round-trip); `DrawingPanel.inspector.test.tsx` covers it
 * wired into the panel.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import { createDrawingInspectorSlice, type DrawingInspectorSlice } from './drawingInspectorSlice.js';

const STORAGE_KEY = 'ifc-lite:drawing-inspector-v1';

const makeStore = () => createStore<DrawingInspectorSlice>(createDrawingInspectorSlice);

describe('drawingInspectorSlice', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to no tab open at the drawer-era width', () => {
    const s = makeStore();
    assert.strictEqual(s.getState().drawingInspectorTab, null);
    assert.strictEqual(s.getState().drawingInspectorWidth, 288);
  });

  it('toggling a tab opens it; toggling the SAME tab again collapses the column', () => {
    const s = makeStore();
    s.getState().toggleDrawingInspectorTab('underlays');
    assert.strictEqual(s.getState().drawingInspectorTab, 'underlays');
    s.getState().toggleDrawingInspectorTab('underlays');
    assert.strictEqual(s.getState().drawingInspectorTab, null);
  });

  it('toggling a DIFFERENT tab switches the column rather than closing it', () => {
    const s = makeStore();
    s.getState().toggleDrawingInspectorTab('overrides');
    s.getState().toggleDrawingInspectorTab('scan');
    assert.strictEqual(s.getState().drawingInspectorTab, 'scan');
  });

  it('closeDrawingInspector collapses the column regardless of which tab is open', () => {
    const s = makeStore();
    s.getState().toggleDrawingInspectorTab('sheet');
    s.getState().closeDrawingInspector();
    assert.strictEqual(s.getState().drawingInspectorTab, null);
  });

  it('setDrawingInspectorWidth clamps to [240, 480]', () => {
    const s = makeStore();
    s.getState().setDrawingInspectorWidth(100);
    assert.strictEqual(s.getState().drawingInspectorWidth, 240);
    s.getState().setDrawingInspectorWidth(900);
    assert.strictEqual(s.getState().drawingInspectorWidth, 480);
    s.getState().setDrawingInspectorWidth(340);
    assert.strictEqual(s.getState().drawingInspectorWidth, 340);
  });

  it('persists the open tab and width to localStorage on every change', () => {
    const s = makeStore();
    s.getState().toggleDrawingInspectorTab('scan');
    s.getState().setDrawingInspectorWidth(360);
    const raw = localStorage.getItem(STORAGE_KEY);
    assert.ok(raw, 'expected the inspector state to be persisted');
    const parsed = JSON.parse(raw!);
    assert.strictEqual(parsed.tab, 'scan');
    assert.strictEqual(parsed.width, 360);
  });

  it('rehydrates a persisted tab and width on next construction', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tab: 'sheet', width: 320 }));
    const s = makeStore();
    assert.strictEqual(s.getState().drawingInspectorTab, 'sheet');
    assert.strictEqual(s.getState().drawingInspectorWidth, 320);
  });

  it('rejects an unknown persisted tab id, falling back to collapsed', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tab: 'not-a-real-tab', width: 300 }));
    const s = makeStore();
    assert.strictEqual(s.getState().drawingInspectorTab, null);
  });

  it('ignores a corrupt (non-JSON) persisted entry rather than throwing at construction', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json');
    assert.doesNotThrow(() => makeStore());
    const s = makeStore();
    assert.strictEqual(s.getState().drawingInspectorTab, null);
    assert.strictEqual(s.getState().drawingInspectorWidth, 288);
  });
});
