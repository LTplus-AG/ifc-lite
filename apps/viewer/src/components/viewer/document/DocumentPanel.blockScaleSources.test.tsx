/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whole-block size (#6548) in the block editor: the one control is on every block with text or graphics,
 * a block that takes new evidence (refresh, a saved report) keeps the size its author chose, and the field
 * shows exactly what is stored.
 */
import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { ValidationReport } from '@ifc-lite/ids';
import { cleanup, click, render, type as typeInput } from '@/test/render.js';
import { useViewerStore } from '@/store/index.js';
import type { BindingContext } from '@/lib/document/bindings';
import { manualReportBlockFromChecklist } from '@/lib/document/manual-report';
import { CHECKLIST_VERSION } from '@/lib/validation/manual/checklist';
import type { DocumentBlock, IdsReportBlock } from '@/lib/document/types';
import { BlockEditor } from './BlockEditor.js';

const BINDINGS: BindingContext = { models: [], activeModelId: null, today: new Date(0) };
const noop = (): void => {};
const SIZE = 'input[aria-label="Block size percentage"]';

const ids: IdsReportBlock = {
  kind: 'ids-report', id: 'ids', variant: 'compact', benchmarks: true, scale: 1.5, sourceName: 'Design IDS', generatedAt: '2026-01-15T10:00:00.000Z',
  summary: { checked: 4, passed: 1, failed: 3, passRate: 25 },
  checks: [{ id: 's1', shortDescription: 'Walls', checked: 4, passed: 1, failed: 3, passRate: 25, rules: [] }],
};
const manual = manualReportBlockFromChecklist({
  checklist: { version: CHECKLIST_VERSION, name: 'Round 3', groups: [{ id: 'g', name: 'Delivery', items: [{ id: 'a', text: 'On time' }] }] },
  answers: { a: { status: 'pass', updatedAt: 1 } }, modelName: 'tower.ifc', now: new Date(Date.UTC(2026, 8, 29)),
}, 'manual');
const liveReport: ValidationReport = {
  source: { kind: 'ids', document: { info: { title: 'Updated IDS' }, specifications: [] } }, modelInfo: [], timestamp: new Date('2026-02-01T00:00:00.000Z'),
  summary: { totalSpecifications: 0, passedSpecifications: 0, failedSpecifications: 0, totalEntitiesChecked: 0, totalEntitiesPassed: 0, totalEntitiesFailed: 0, overallPassRate: 0 },
  specificationResults: [{ specification: { id: 'r1', name: 'Rule one' }, status: 'fail', applicableCount: 4, passedCount: 1, failedCount: 3, passRate: 25, entityResults: [] }],
};

function editor(block: DocumentBlock, onChange: (b: DocumentBlock) => void = noop, report: ValidationReport | null = null): HTMLElement {
  return render(<BlockEditor block={block} index={0} count={1} bindings={BINDINGS} topics={new Map()} charts={[]} idsValidationReport={report} onChange={onChange} onMove={noop} onRemove={noop} />);
}
const settle = async (): Promise<void> => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
  useViewerStore.setState({ savedValidationReports: [], idsValidationReport: null });
});
afterEach(cleanup);

describe('the block size control is on every block that has text or graphics (#6548)', () => {
  const blocks: DocumentBlock[] = [
    { kind: 'text', id: 't', style: 'body', text: 'x' },
    { kind: 'image', id: 'i', dataUrl: 'data:image/png;base64,AAAA', height: 40, align: 'left' },
    { kind: 'chart', id: 'c', chart: { id: 'k', title: 'C', source: 'elements', type: 'bar', dimension: 'IfcType', measure: { agg: 'count' } }, snapshot: false },
    { kind: 'topic', id: 'p', guid: 'g', snapshot: false },
    { kind: 'table', id: 'tb', source: { kind: 'validation', rows: 'failed', columns: ['rule'] } },
    ids,
    manual,
  ];
  for (const block of blocks) {
    it(`${block.kind}: present`, () => {
      assert.equal(editor(block).querySelectorAll(SIZE).length, 1);
    });
  }
  for (const block of [{ kind: 'spacer', id: 's', height: 20 }, { kind: 'page-break', id: 'b' }] as DocumentBlock[]) {
    it(`${block.kind}: absent`, () => {
      assert.equal(editor(block).querySelectorAll(SIZE).length, 0);
    });
  }
});

describe('a block that takes new evidence keeps its size (#6548)', () => {
  const choose = async (ui: HTMLElement, name: string): Promise<void> => {
    const select = ui.querySelector<HTMLSelectElement>('select[aria-label="Saved report source"]');
    assert.ok(select, 'the saved report source is offered');
    const option = [...select.options].find((candidate) => candidate.textContent?.includes(name));
    assert.ok(option, `the saved report named ${name} is offered`);
    act(() => { select.value = option.value; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
    await settle();
  };
  const save = async (snapshot: IdsReportBlock | ReturnType<typeof manualReportBlockFromChecklist>, name: string): Promise<string> => {
    let id: string | null = null;
    await act(async () => { id = await useViewerStore.getState().saveValidationReport(snapshot, name); });
    assert.ok(id, 'the report history accepted the snapshot');
    return id;
  };

  it('refreshing an IDS report from the live report', () => {
    const changes: DocumentBlock[] = [];
    const ui = editor(ids, (b) => changes.push(b), liveReport);
    const refresh = [...ui.querySelectorAll('button')].find((b) => b.textContent?.includes('Refresh from current validation report'));
    assert.ok(refresh);
    click(refresh);
    assert.equal(changes.length, 1);
    assert.equal((changes[0] as IdsReportBlock).sourceName, 'Updated IDS', 'the evidence was replaced');
    assert.equal((changes[0] as IdsReportBlock).scale, 1.5);
  });

  it('choosing a saved IDS report for an IDS block', async () => {
    await save({ ...ids, id: 'saved', scale: undefined, sourceName: 'Frozen IDS' }, 'Frozen');
    const changes: DocumentBlock[] = [];
    const ui = editor(ids, (b) => changes.push(b));
    await choose(ui, 'Frozen');
    assert.equal((changes[0] as IdsReportBlock).sourceName, 'Frozen IDS');
    assert.equal((changes[0] as IdsReportBlock).scale, 1.5);
  });

  it('choosing a saved manual report for an IDS block, and a saved IDS report for a manual block', async () => {
    await save({ ...manual, id: 'saved-manual' }, 'Frozen manual');
    await save({ ...ids, id: 'saved-ids', scale: undefined }, 'Frozen IDS');
    const changes: DocumentBlock[] = [];
    await choose(editor(ids, (b) => changes.push(b)), 'Frozen manual');
    assert.equal(changes[0].kind, 'manual-report');
    assert.equal((changes[0] as { scale?: number }).scale, 1.5, 'an IDS block turned into a manual report');
    cleanup();
    await choose(editor({ ...manual, scale: 0.75 }, (b) => changes.push(b)), 'Frozen IDS');
    assert.equal(changes[1].kind, 'ids-report');
    assert.equal((changes[1] as { scale?: number }).scale, 0.75, 'a manual block turned into an IDS report');
  });
});

describe('the field shows what is stored (#6548)', () => {
  const commit = async (input: HTMLInputElement, value: string): Promise<void> => {
    typeInput(input, value);
    act(() => input.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })));
    await settle();
  };

  it('a typed 120.5 is committed as 121, the whole percent the field shows, not as 1.205 under a field reading 121', async () => {
    const changes: DocumentBlock[] = [];
    const ui = editor({ kind: 'text', id: 't', style: 'body', text: 'x' }, (b) => changes.push(b));
    const input = ui.querySelector<HTMLInputElement>(SIZE)!;
    await commit(input, '120.5');
    assert.equal((changes.at(-1) as { scale?: number }).scale, 1.21);
    assert.equal(input.value, '121');
    await commit(input, '33.3');
    assert.equal((changes.at(-1) as { scale?: number }).scale, 0.5, 'clamped as before');
    await commit(input, '100.4');
    assert.equal((changes.at(-1) as { scale?: number }).scale, undefined, 'a value that rounds to 100 clears the override');
  });
});
