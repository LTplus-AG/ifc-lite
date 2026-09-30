/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6507: mount the live library and Documentation's real controls in both
 * locales; source names remain user content while chrome retranslates. */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { manualValidationEn } from '@/i18n/catalogues/manual-validation.en';
import { useViewerStore } from '@/store';
import { manualReportBlockFromChecklist } from '@/lib/document/manual-report';
import { ValidationPanel } from './ValidationPanel';
import { ManualReportBlockEditor, ManualReportPresentation } from '../document/ManualReportBlockEditor';

const initial = useViewerStore.getState();
const keys = [
  'manualValidation.error.noChecklist',
  'manualValidation.library.select', 'manualValidation.library.none',
  'manualValidation.library.duplicate', 'manualValidation.library.remove',
  'manualValidation.report.sourceLabel', 'manualValidation.report.checklistMissing',
  'manualValidation.report.layout', 'manualValidation.report.long',
  'manualValidation.report.compact', 'manualValidation.report.benchmarks',
] as const;
const marked = (key: typeof keys[number]) => `⟦${key}⟧`;
const pseudo: Catalogue = Object.fromEntries(keys.map((key) => [key, marked(key)]));
registerLocale('manual-library-6507', pseudo);

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState(initial);
  localStorage.clear();
});

describe('manual library and document source localization (#6507)', () => {
  for (const locale of ['en', 'manual-library-6507']) {
    it(`mounts every new library/source/layout control in ${locale}`, () => {
      localStorage.clear();
      useViewerStore.setState(initial);
      useViewerStore.getState().setManualChecklist({ version: 1, name: 'Architecture', groups: [{ id: 'g', name: 'Delivery', items: [{ id: 'q', text: 'Survey approved' }] }] });
      const originalId = useViewerStore.getState().manualLibrary.activeId!;
      useViewerStore.getState().duplicateManualChecklist(originalId, 'Structure');
      const checklist = useViewerStore.getState().manualChecklist!;
      const block = manualReportBlockFromChecklist({ checklist, answers: {}, checklistId: useViewerStore.getState().manualLibrary.activeId! }, 'report');
      setLocale(locale);
      const label = (key: typeof keys[number]) => locale === 'en' ? manualValidationEn[key] : marked(key);
      const library = render(<ValidationPanel />);
      assert.ok(library.querySelector(`select[aria-label="${label('manualValidation.library.select')}"]`));
      for (const key of ['manualValidation.library.none', 'manualValidation.library.duplicate', 'manualValidation.library.remove'] as const) {
        assert.ok(library.textContent?.includes(label(key)), `real library renders ${key}`);
      }
      assert.ok(library.textContent?.includes('Architecture'));
      assert.ok(library.textContent?.includes('Structure'));
      act(() => {
        useViewerStore.getState().setManualChecklist(null);
        useViewerStore.getState().setManualAnswer('model-fingerprint', 'q', { status: 'pass' });
      });
      assert.ok(library.querySelector('[role="alert"]')?.textContent?.includes(label('manualValidation.error.noChecklist')));
      act(() => useViewerStore.getState().selectManualChecklist(originalId));
      cleanup();

      const editor = render(<><ManualReportBlockEditor block={block} onChange={() => {}} /><ManualReportPresentation block={block} onChange={() => {}} /></>);
      assert.ok(editor.querySelector(`select[aria-label="${label('manualValidation.report.sourceLabel')}"]`));
      assert.ok(editor.querySelector(`select[aria-label="${label('manualValidation.report.layout')}"]`));
      for (const key of ['manualValidation.report.long', 'manualValidation.report.compact', 'manualValidation.report.benchmarks'] as const) {
        assert.ok(editor.textContent?.includes(label(key)), `real presentation renders ${key}`);
      }
      act(() => useViewerStore.getState().removeManualChecklist(block.checklistId!));
      assert.ok(editor.textContent?.includes(label('manualValidation.report.checklistMissing')));
    });
  }
});
