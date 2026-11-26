/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #11581: the title block editor showed the stored Scale text, so a 1:50
 * sheet restored with the default '1:100' field read 1:100 while the export
 * printed 1:50. The editor now shows an auto-populated Scale at the sheet's
 * own scale (it cannot know the viewport fit, which only the drawing has).
 */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { createDefaultSheet } from '@/store/slices/sheetSlice';
import { restoreSheet } from '@/store/slices/sheetSlice.validation';
import { TitleBlockEditor } from './TitleBlockEditor.js';

afterEach(() => {
  cleanup();
  useViewerStore.setState({ activeSheet: null, sheetEnabled: false });
});

it('shows an auto-populated Scale at the sheet scale, not a stale stored copy (#11581)', () => {
  const sheet = restoreSheet({ ...createDefaultSheet(), scale: { name: '1:50', factor: 50, useCase: 'x' } });
  assert.ok(sheet);
  assert.equal(sheet.titleBlock.fields.find((f) => f.id === 'scale')?.value, '1:100', 'fixture carries the stale copy');
  useViewerStore.setState({ activeSheet: sheet, sheetEnabled: true });
  render(<TitleBlockEditor open onOpenChange={() => {}} />);
  // The dialog renders in a portal on document.body.
  const scale = document.body.querySelector<HTMLInputElement>('input[aria-label="Scale"]');
  assert.equal(scale?.value, '1:50');
});

it('leaves an editable Scale field showing what the user typed', () => {
  const sheet = restoreSheet({ ...createDefaultSheet(), scale: { name: '1:50', factor: 50, useCase: 'x' } });
  assert.ok(sheet);
  sheet.titleBlock.fields = sheet.titleBlock.fields.map((f) => (f.id === 'scale' ? { ...f, editable: true, value: 'As indicated' } : f));
  useViewerStore.setState({ activeSheet: sheet, sheetEnabled: true });
  render(<TitleBlockEditor open onOpenChange={() => {}} />);
  assert.equal(document.body.querySelector<HTMLInputElement>('input[aria-label="Scale"]')?.value, 'As indicated');
});
