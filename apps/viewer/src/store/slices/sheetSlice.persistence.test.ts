/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { createDefaultSheet } from './sheetSlice';
import { loadSheet, loadSheetTemplates, saveSheet, saveSheetTemplates, sheetStorageKey, SHEET_TEMPLATES_KEY } from './sheetSlice.persistence';
import { calculateViewportBounds } from '@ifc-lite/drawing-2d';

beforeEach(() => localStorage.clear());

describe('sheet storage (#4836)', () => {
  it('round-trips the complete production sheet contract, including custom fields and embedded logos', () => {
    const sheet = createDefaultSheet({ paperId: 'A2_PORTRAIT', frameStyle: 'iso', titleBlockLayout: 'extended' });
    sheet.name = 'Elevation and annotations';
    sheet.titleBlock.fields.push({
      id: 'custom', label: 'Approver', value: 'Review team', editable: true, autoPopulate: false,
      autoPopulateSource: 'project.name', fontSize: 4, fontWeight: 'bold', maxWidth: 22,
      row: 6, col: 1, rowSpan: 2, colSpan: 3,
    });
    sheet.titleBlock.backgroundColor = '#fafafa';
    sheet.titleBlock.logo = { source: 'data:image/png;base64,aGVsbG8=', widthMm: 24, heightMm: 12, position: 'top-right' };
    sheet.revisions = [{ revision: 'C', description: 'Dimensions checked', date: '2026-09-15', author: 'Reviewer' }];
    sheet.scaleBar = { visible: false, totalLengthM: 8, primaryDivisions: 4, heightMm: 2, fillColor: '#112233', strokeColor: '#445566', lineWeight: 0.4 };
    sheet.northArrow = { style: 'compass', rotation: -42, sizeMm: 22 };
    sheet.scale = { name: '1:75', factor: 75, useCase: 'Coordination' };
    saveSheet('model-a', sheet);
    saveSheetTemplates([sheet]);
    assert.deepEqual(loadSheet('model-a'), sheet);
    assert.deepEqual(loadSheetTemplates(), [sheet]);
    assert.equal(loadSheet('model-b'), null);
  });

  it('recovers valid fields and templates independently, recalculating derived viewport bounds', () => {
    const sheet = createDefaultSheet();
    const damaged = {
      ...sheet, scale: { ...sheet.scale, factor: 0 },
      frame: { ...sheet.frame, margins: { ...sheet.frame.margins, left: -10, right: 17 } },
      titleBlock: { ...sheet.titleBlock, fields: [null, ...sheet.titleBlock.fields], logo: { source: 42 } },
      viewportBounds: { x: 999, y: 999, width: -1, height: -1 }, revisions: [null, { revision: 'A', description: 'Keep this' }],
    };
    localStorage.setItem(sheetStorageKey('damaged'), JSON.stringify({ sheet: damaged }));
    localStorage.setItem(SHEET_TEMPLATES_KEY, JSON.stringify({ templates: [null, { id: 42 }, damaged] }));
    const restored = loadSheet('damaged');
    assert.ok(restored);
    assert.equal(restored.frame.margins.right, 17);
    assert.equal(restored.frame.margins.left, sheet.frame.margins.left);
    assert.equal(restored.scale.factor, sheet.scale.factor);
    assert.deepEqual(restored.titleBlock.fields, sheet.titleBlock.fields);
    assert.equal(restored.titleBlock.logo, null);
    assert.equal(restored.revisions[0].description, 'Keep this');
    assert.deepEqual(restored.viewportBounds, calculateViewportBounds(restored.paper, restored.frame, restored.titleBlock));
    assert.equal(loadSheetTemplates().length, 1);
  });

  it('logs parse and quota errors, preserving the last successfully saved sheet', () => {
    const warn = mock.method(console, 'warn', () => {});
    localStorage.setItem(sheetStorageKey('broken'), '{');
    assert.equal(loadSheet('broken'), null);
    localStorage.removeItem(sheetStorageKey('broken'));
    const sheet = createDefaultSheet();
    saveSheet('model', sheet);
    const setItem = mock.method(localStorage, 'setItem', () => { throw new Error('quota exceeded'); });
    saveSheet('model', { ...sheet, name: 'Unstored edit' });
    saveSheetTemplates([sheet]);
    setItem.mock.restore();
    assert.deepEqual(loadSheet('model'), sheet);
    assert.equal(warn.mock.callCount(), 3);
    warn.mock.restore();
  });

  it('degrades without throwing when storage enumeration is denied', () => {
    const warn = mock.method(console, 'warn', () => {});
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('storage access denied'); },
    });
    try {
      assert.doesNotThrow(() => saveSheet('enumeration-denied', createDefaultSheet()));
      assert.ok(warn.mock.callCount() >= 1);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
      warn.mock.restore();
    }
  });

  it('keeps the newest 20 model sheets and never evicts reusable templates', () => {
    const sheet = createDefaultSheet();
    saveSheetTemplates([sheet]);
    for (let i = 0; i < 21; i++) {
      const now = mock.method(Date, 'now', () => i + 1);
      saveSheet(`model-${i}`, sheet);
      now.mock.restore();
    }
    assert.equal(loadSheet('model-0'), null);
    assert.deepEqual(loadSheet('model-20'), sheet);
    assert.equal(localStorage.length, 21);
    assert.deepEqual(loadSheetTemplates(), [sheet]);
  });

  it('retains sheets by save order when multiple writes share a timestamp', () => {
    const now = mock.method(Date, 'now', () => 100);
    const sheet = createDefaultSheet();
    for (let i = 0; i < 20; i++) saveSheet(`z-old-${i}`, { ...sheet, name: `Old ${i}` });
    saveSheet('a-new', { ...sheet, name: 'Newer' });
    saveSheet('b-newest', { ...sheet, name: 'Newest' });
    now.mock.restore();
    assert.equal(loadSheet('z-old-0'), null);
    assert.equal(loadSheet('z-old-1'), null);
    assert.equal(loadSheet('a-new')?.name, 'Newer');
    assert.equal(loadSheet('b-newest')?.name, 'Newest');
    assert.equal(loadSheet('z-old-19')?.name, 'Old 19');
  });

  it('rejects non-finite persisted ordering metadata instead of poisoning later saves', () => {
    const now = mock.method(Date, 'now', () => 100);
    const sheet = createDefaultSheet();
    for (let i = 0; i < 20; i++) saveSheet(`old-${i}`, { ...sheet, name: `Old ${i}` });
    const key = sheetStorageKey('old-0');
    const raw = localStorage.getItem(key);
    assert.ok(raw);
    const poisoned = raw.replace(/"savedOrder":"\d+"/, '"savedOrder":1e400');
    assert.equal((JSON.parse(poisoned) as Record<string, unknown>).savedOrder, Infinity);
    localStorage.setItem(key, poisoned);
    saveSheet('newer', { ...sheet, name: 'Newer' });
    saveSheet('newest', { ...sheet, name: 'Newest' });
    now.mock.restore();

    assert.equal(loadSheet('old-0'), null);
    assert.equal(loadSheet('newer')?.name, 'Newer');
    assert.equal(loadSheet('newest')?.name, 'Newest');
  });

  it('orders safely beyond the numeric safe-integer boundary', () => {
    const now = mock.method(Date, 'now', () => 100);
    const sheet = createDefaultSheet();
    for (let i = 0; i < 20; i++) saveSheet(`old-${i}`, { ...sheet, name: `Old ${i}` });
    const key = sheetStorageKey('old-0');
    const entry = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
    entry.savedOrder = Number.MAX_SAFE_INTEGER - 1;
    localStorage.setItem(key, JSON.stringify(entry));
    saveSheet('newer', { ...sheet, name: 'Newer' });
    saveSheet('newest', { ...sheet, name: 'Newest' });
    now.mock.restore();

    assert.equal(loadSheet('old-1'), null);
    assert.equal(loadSheet('newer')?.name, 'Newer');
    assert.equal(loadSheet('newest')?.name, 'Newest');
    assert.match(localStorage.getItem(sheetStorageKey('newest')) ?? '', /"savedOrder":"\d+"/);
  });

  it('persists an explicit clear within the bounded cache and preserves the last choice if the write fails', () => {
    const sheet = createDefaultSheet();
    for (let i = 0; i < 20; i++) saveSheet(`kept-${i}`, sheet);
    const warn = mock.method(console, 'warn', () => {});
    const write = mock.method(localStorage, 'setItem', () => { throw new Error('storage denied'); });
    saveSheet('kept-0', null);
    write.mock.restore();
    assert.deepEqual(loadSheet('kept-0'), sheet);
    assert.equal(warn.mock.callCount(), 1);
    warn.mock.restore();
    saveSheet('kept-0', null);
    assert.equal(loadSheet('kept-0'), null);
    assert.equal(JSON.parse(localStorage.getItem(sheetStorageKey('kept-0'))!).sheet, null);
    saveSheet('new-choice', null);
    assert.equal(localStorage.length, 20, 'cleared choices cannot grow storage without a bound');
    assert.equal(loadSheet('kept-1'), null, 'the least recent choice is evicted');
    for (let i = 2; i < 20; i++) assert.deepEqual(loadSheet(`kept-${i}`), sheet);
  });
});
