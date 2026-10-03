/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Regression coverage for the canonical document preview's validation-source localization (#5138 review): the
 * column headers and the untitled-block fallback title use the captured locale in preview and PDF;
 * authored titles remain model content. */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { documentPreviewReady } from '@/test/document-preview';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TableState } from '@/lib/document/resolve-table';
import type { TableBlock } from '@/lib/document/types';
import { DocumentPreview } from './DocumentPreview.js';
import { DOCUMENT_VERSION } from '@/lib/document/types';

const TEST_LOCALE: Catalogue = {
  'document.block.tableSourceValidation': 'Validierungsergebnisse',
  'document.table.column.rule': 'Regel',
  'document.table.column.result': 'Ergebnis',
};

afterEach(() => {
  cleanup();
  setLocale('en');
});

function mount(block: TableBlock, state?: TableState) {
  return render(<DocumentPreview document={{ version: DOCUMENT_VERSION, id: 'localized-table', name: 'Report',
    page: { size: 'A4', orientation: 'portrait' }, blocks: [block] }}
    bindings={{ models: [], activeModelId: null, today: new Date(0) }} aggregations={new Map()}
    chartMessages={new Map()} topics={new Map()} tables={state ? new Map([[block.id, state]]) : new Map()}
    selectedBlockId={null} onSelectBlock={() => {}} />);
}

describe('Canonical table preview localization — validation source (#5138)', () => {
  it('translates the column headers, and the untitled-block fallback title', async () => {
    const block: TableBlock = { kind: 'table', id: 'tb', source: { kind: 'validation', rows: 'failed', columns: ['rule', 'result'] } };
    const state: TableState = {
      status: 'ok',
      kind: 'validation',
      model: {
        columns: [{ id: 'rule', label: 'Rule', numeric: false }, { id: 'result', label: 'Result', numeric: false }],
        rows: [{ cells: ['Walls have FireRating', 'fail'], role: 'row' }],
        totalRows: 1,
      },
    };
    const ui = mount(block, state);
    await documentPreviewReady();
    assert.equal(ui.textContent?.includes('Validation results'), true, 'the untitled block falls back to the source-kind label');
    const headers = [...ui.querySelectorAll('th')].map((th) => th.textContent);
    assert.deepEqual(headers, ['Rule', 'Result']);

    registerLocale('table-preview-x', TEST_LOCALE);
    act(() => setLocale('table-preview-x'));
    await documentPreviewReady();

    assert.equal(ui.textContent?.includes('Validierungsergebnisse'), true, 'the fallback title switches with the locale');
    const translatedHeaders = [...ui.querySelectorAll('th')].map((th) => th.textContent);
    assert.deepEqual(translatedHeaders, ['Regel', 'Ergebnis']);
  });

  it('a titled block keeps its own title untranslated — that is model content, not chrome', async () => {
    const block: TableBlock = { kind: 'table', id: 'tb2', title: 'Fire ratings', source: { kind: 'validation', rows: 'failed', columns: ['rule'] } };
    const ui = mount(block);
    await documentPreviewReady();
    assert.equal(ui.textContent?.includes('Fire ratings'), true);
  });
});
