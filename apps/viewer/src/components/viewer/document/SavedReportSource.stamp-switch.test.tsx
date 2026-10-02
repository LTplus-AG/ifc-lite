/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { emptyManualReportBlock } from '@/lib/document/manual-report';
import { newSavedReport, type ValidationReportSnapshot } from '@/lib/validation/reports/history';
import type { IdsReportBlock } from '@/lib/document/types';
import { SavedReportSource } from './SavedReportSource.js';
const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

  const ids: IdsReportBlock = { kind: 'ids-report', id: 'ids', sourceKind: 'ids', sourceName: 'IDS', generatedAt: '2026-01-01T00:00:00Z', summary: { checked: 0, passed: 0, failed: 0, passRate: 0 }, checks: [] };
  const manual = emptyManualReportBlock('manual');
for (const [destination, source] of [[ids, manual], [manual, ids]] as const) {
  it(`keeps the hidden stamp when ${destination.kind} changes to ${source.kind} (#6678)`, () => {
    const saved = newSavedReport({ ...source, showStamp: true }, 'Saved source');
    useViewerStore.setState({ savedValidationReports: [saved] });
    const replacements: ValidationReportSnapshot[] = [];
    const ui = render(<SavedReportSource block={{ ...destination, showStamp: false }} onChange={(block) => replacements.push(block)} />);
    const picker = ui.querySelector<HTMLSelectElement>('select'); assert.ok(picker);
    act(() => { picker.value = saved.id; picker.dispatchEvent(new window.Event('change', { bubbles: true })); });
    assert.equal(replacements.length, 1);
    assert.equal(replacements[0].kind, source.kind, 'the selected evidence kind really changes');
    assert.equal(replacements[0].showStamp, false, `${destination.kind} to ${source.kind}: the destination stamp choice wins`);
  });
}
