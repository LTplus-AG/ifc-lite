/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Choosing saved evidence for a report block keeps what its author chose (#6678, #6632, #6560): through
 * the real picker, same kind and across kinds, every shared choice (heading text and style, size, hidden
 * stamp) is the destination's, and for the same kind so are layout, benchmarks and specifications-only.
 * Across kinds layout and benchmarks take the new evidence's defaults. A choice cleared on the
 * destination is not brought back from the saved snapshot.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { emptyManualReportBlock } from '@/lib/document/manual-report';
import { newSavedReport, type ValidationReportSnapshot } from '@/lib/validation/reports/history';
import type { IdsReportBlock } from '@/lib/document/types';
import type { ManualReportBlock } from '@/lib/document/manual-report-types';
import { SavedReportSource } from './SavedReportSource.js';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

const idsBase: IdsReportBlock = { kind: 'ids-report', id: 'ids', sourceKind: 'ids', sourceName: 'IDS', generatedAt: '2026-01-01T00:00:00Z', summary: { checked: 0, passed: 0, failed: 0, passRate: 0 }, checks: [] };
const manualBase: ManualReportBlock = emptyManualReportBlock('manual');
const HEADING = { title: 'Mine', titleFontSize: 20, titleTextColor: '#112233', titleBackgroundColor: '#ddeeff' };
// The destination's authored choices, and a saved snapshot whose every one conflicts.
const mine = { ...HEADING, scale: 1.5, showStamp: false, benchmarks: false, variant: 'long' as const };
const theirs = { title: 'Saved', titleFontSize: 8, titleTextColor: '#aa0000', titleBackgroundColor: '#00aa00', scale: 0.5, showStamp: true, benchmarks: true, variant: 'compact' as const };

function choose(destination: ValidationReportSnapshot, source: ValidationReportSnapshot): ValidationReportSnapshot {
  const saved = newSavedReport(source, 'Saved source');
  useViewerStore.setState({ savedValidationReports: [saved] });
  const replacements: ValidationReportSnapshot[] = [];
  const ui = render(<SavedReportSource block={destination} onChange={(block) => replacements.push(block)} />);
  const picker = ui.querySelector<HTMLSelectElement>('select'); assert.ok(picker, 'the saved-source picker is mounted');
  act(() => { picker.value = saved.id; picker.dispatchEvent(new window.Event('change', { bubbles: true })); });
  assert.equal(replacements.length, 1);
  cleanup();
  return replacements[0];
}

describe('saved-source choice keeps the destination block\'s choices (#6678)', () => {
  const idsDestination: IdsReportBlock = { ...idsBase, ...mine, specificationsOnly: true };
  const idsSource: IdsReportBlock = { ...idsBase, sourceName: 'Other IDS', ...theirs, specificationsOnly: false };
  const manualDestination: ManualReportBlock = { ...manualBase, ...mine };
  const manualSource: ManualReportBlock = { ...manualBase, checklistName: 'Other', ...theirs };

  for (const [name, destination, source] of [['IDS to IDS', idsDestination, idsSource], ['manual to manual', manualDestination, manualSource]] as const) {
    it(`${name}: heading, size, stamp, layout and benchmarks stay the destination's`, () => {
      const result = choose(destination, source);
      assert.equal(result.kind, source.kind);
      assert.equal(result.id, destination.id);
      assert.deepEqual([result.title, result.titleFontSize, result.titleTextColor, result.titleBackgroundColor], ['Mine', 20, '#112233', '#ddeeff']);
      assert.deepEqual([result.scale, result.showStamp, result.benchmarks, result.variant], [1.5, false, false, 'long']);
      if (result.kind === 'ids-report') assert.equal(result.specificationsOnly, true, 'the specifications-only choice stays');
    });
  }

  for (const [name, destination, source] of [['IDS to manual', idsDestination, manualSource], ['manual to IDS', manualDestination, idsSource]] as const) {
    it(`${name}: heading, size and stamp stay the destination's, layout and benchmarks take the new evidence's`, () => {
      const result = choose(destination, source);
      assert.equal(result.kind, source.kind, 'the evidence kind really changes');
      assert.deepEqual([result.title, result.titleFontSize, result.titleTextColor, result.titleBackgroundColor], ['Mine', 20, '#112233', '#ddeeff']);
      assert.deepEqual([result.scale, result.showStamp], [1.5, false]);
      assert.deepEqual([result.benchmarks, result.variant], [true, 'compact'], 'cross-kind layout and benchmarks are the new evidence\'s');
    });
  }

  it('does not bring back a choice cleared on the destination, in the saved document either', () => {
    for (const [destination, source] of [[idsBase, manualSource], [manualBase, idsSource], [idsBase, { ...idsSource, specificationsOnly: true }], [manualBase, manualSource]] as const) {
      const result = choose(destination, source);
      const saved = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
      for (const key of ['title', 'titleFontSize', 'titleTextColor', 'titleBackgroundColor', 'scale', 'showStamp']) {
        assert.equal(key in saved, false, `${destination.kind} to ${source.kind}: ${key} was cleared on the destination and is not in the saved JSON`);
      }
      // Specifications-only belongs to the IDS kind: it is kept (or kept unset) only when both blocks are IDS reports.
      if (destination.kind === 'ids-report' && source.kind === 'ids-report') assert.equal('specificationsOnly' in saved, false, 'IDS to IDS: specifications-only was cleared on the destination');
    }
  });
});
