/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `sheetSlice` is one of the 17 slices in #2802 with zero test references.
 *
 * The property pinned here: `clearSheet` resets the *active* sheet/panel
 * state, not the user's saved-template library. `getDefaultState()` is
 * shared between the store's initial state (which correctly starts with an
 * empty template list) and `clearSheet` (which reused it verbatim), so
 * clicking "clear sheet" silently deleted every saved template — a
 * destructive side effect with no relation to what the action name promises.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import { createSheetSlice, type SheetSlice } from './sheetSlice.js';

const make = () => createStore<SheetSlice>(createSheetSlice);

describe('sheetSlice: changing the drawing scale (#11620)', () => {
  const newScale = { factor: 50, name: '1:50', useCase: 'Floor plans' };

  it('preserves the Scale text when auto-populate is off or uses another source', () => {
    for (const settings of [
      { autoPopulate: false, autoPopulateSource: 'drawing.scale' },
      { autoPopulate: true, autoPopulateSource: 'project.name' },
    ]) {
      const s = make();
      s.getState().createSheet();
      const field = s.getState().activeSheet?.titleBlock.fields.find(({ id }) => id === 'scale');
      assert.ok(field);
      s.getState().removeTitleBlockField(field.id);
      s.getState().addTitleBlockField({ ...field, ...settings, value: 'As indicated' });

      s.getState().setDrawingScale(newScale);

      const sheet = s.getState().activeSheet;
      assert.equal(sheet?.scale.factor, 50);
      assert.equal(sheet?.titleBlock.fields.find(({ id }) => id === 'scale')?.value, 'As indicated');
    }
  });

  it('updates every field sourced from the drawing scale, including custom fields', () => {
    const s = make();
    s.getState().createSheet();
    const field = s.getState().activeSheet?.titleBlock.fields.find(({ id }) => id === 'scale');
    assert.ok(field);
    s.getState().addTitleBlockField({ ...field, id: 'detail-scale' });

    s.getState().setDrawingScale(newScale);

    const fields = s.getState().activeSheet?.titleBlock.fields;
    assert.equal(fields?.find(({ id }) => id === 'scale')?.value, '1:50');
    assert.equal(fields?.find(({ id }) => id === 'detail-scale')?.value, '1:50');
  });
});

describe('sheetSlice: clearSheet does not destroy saved templates', () => {
  it('preserves savedSheetTemplates across a clearSheet call', () => {
    const s = make();
    s.getState().createSheet();
    s.getState().saveAsTemplate('My Template');

    assert.equal(s.getState().savedSheetTemplates.length, 1);

    s.getState().clearSheet();

    assert.equal(s.getState().activeSheet, null, 'active sheet is reset');
    assert.equal(s.getState().sheetEnabled, false, 'sheet-enabled flag is reset');
    assert.equal(
      s.getState().savedSheetTemplates.length,
      1,
      'saved templates must survive clearing the active sheet'
    );
    assert.equal(s.getState().savedSheetTemplates[0]?.name, 'My Template');
  });

  it('still starts with no templates on a fresh store', () => {
    const s = make();
    assert.equal(s.getState().savedSheetTemplates.length, 0);
  });

  it('keeps templates addressable when saves share a timestamp', () => {
    const now = mock.method(Date, 'now', () => 100);
    const s = make();
    s.getState().createSheet();
    s.getState().saveAsTemplate('First');
    s.getState().saveAsTemplate('Second');
    now.mock.restore();

    assert.deepEqual(
      s.getState().savedSheetTemplates.map(({ id, name }) => ({ id, name })),
      [
        { id: 'template-100', name: 'First' },
        { id: 'template-100-2', name: 'Second' },
      ]
    );
  });
});
