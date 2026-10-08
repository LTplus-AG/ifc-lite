/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The compact IDS report's "specifications only" option (#6560) in the
 * preview and the block editor: the preview drops requirement rows, the
 * editor offers the option only for the compact layout, and refreshing the
 * snapshot keeps the choice.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ValidationReport } from '@ifc-lite/ids';
import { cleanup, click, render } from '@/test/render.js';
import type { BindingContext } from '@/lib/document/bindings';
import type { DocumentBlock, IdsReportBlock } from '@/lib/document/types';
import { BlockEditor } from './BlockEditor.js';
import { IdsReportPreview } from './IdsReportPreview.js';

const BINDINGS: BindingContext = { models: [], activeModelId: null, today: new Date(0) };
const noop = (): void => {};
const rule = (id: string, name: string) => ({ id, name, shortDescription: `${name} must exist`, checked: 6, passed: 6, failed: 0, passRate: 100 });
const base: IdsReportBlock = {
  kind: 'ids-report', id: 'b', variant: 'compact', sourceName: 'Design IDS', generatedAt: '2026-01-15T10:00:00.000Z',
  summary: { checked: 12, passed: 12, failed: 0, passRate: 100 },
  checks: [
    { id: 's1', shortDescription: 'Geschoss', checked: 6, passed: 6, failed: 0, passRate: 100, rules: [rule('r1', 'Status'), rule('r2', 'Material')] },
    { id: 's2', shortDescription: 'Raum', checked: 6, passed: 6, failed: 0, passRate: 100, rules: [rule('r3', 'Raumname')] },
  ],
};

const rowCount = (ui: HTMLElement): number => ui.querySelectorAll('[data-ids-report-row]').length;
const liveReport = {
  source: { kind: 'ids', document: { info: { title: 'Design IDS' }, specifications: [] } }, modelInfo: [], timestamp: new Date(0),
  summary: { totalSpecifications: 0, passedSpecifications: 0, failedSpecifications: 0, totalEntitiesChecked: 0, totalEntitiesPassed: 0, totalEntitiesFailed: 0, overallPassRate: 0 },
  specificationResults: [{ specification: { id: 's', name: 'Walls' }, status: 'pass', applicableCount: 1, passedCount: 1, failedCount: 0, passRate: 100, entityResults: [] }],
} as unknown as ValidationReport;

function editor(block: IdsReportBlock, onChange: (b: DocumentBlock) => void = noop, report: ValidationReport | null = null) {
  return render(<BlockEditor block={block} index={0} count={1} bindings={BINDINGS} topics={new Map()} charts={[]} idsValidationReport={report} onChange={onChange} onMove={noop} onCopy={noop} onRemove={noop} />);
}
const toggle = (ui: HTMLElement): HTMLInputElement | undefined =>
  [...ui.querySelectorAll('label')].find((l) => l.textContent?.includes('Specifications only'))?.querySelector('input') as HTMLInputElement | undefined;

afterEach(cleanup);

describe('specifications-only IDS report preview (#6560)', () => {
  it('shows one row per specification and none for requirements', () => {
    assert.equal(rowCount(render(<IdsReportPreview block={base} />)), 5, 'two specifications and three requirements');
    cleanup();
    const ui = render(<IdsReportPreview block={{ ...base, specificationsOnly: true }} />);
    assert.equal(rowCount(ui), 2);
    assert.equal(ui.querySelectorAll('[data-ids-report-requirements]').length, 0, 'no requirement lists');
    assert.ok((ui.textContent ?? '').includes('6/6 · 100%'), 'the specification keeps its pass rate');
  });

  it('is ignored outside the compact layout', () => {
    const ui = render(<IdsReportPreview block={{ ...base, variant: 'long', specificationsOnly: true }} />);
    assert.ok((ui.textContent ?? '').includes('Material must exist'), 'long still lists requirements');
  });
});

describe('specifications-only option in the block editor (#6560)', () => {
  it('offers the option for the compact layout and writes the choice', () => {
    const changes: DocumentBlock[] = [];
    const ui = editor(base, (b) => changes.push(b));
    const box = toggle(ui);
    assert.ok(box, 'the option is offered for compact');
    assert.equal(box.checked, false);
    click(box);
    assert.equal((changes[0] as IdsReportBlock).specificationsOnly, true);
  });

  it('does not offer the option for the long layout', () => {
    assert.equal(toggle(editor({ ...base, variant: 'long' })), undefined);
  });

  it('keeps the choice when the snapshot is refreshed from the live report', () => {
    const changes: DocumentBlock[] = [];
    const ui = editor({ ...base, specificationsOnly: true }, (b) => changes.push(b), liveReport);
    const button = [...ui.querySelectorAll('button')].find((b) => b.textContent?.includes('Refresh from current validation report'));
    assert.ok(button, 'refresh is offered');
    click(button as HTMLButtonElement);
    assert.equal((changes[0] as IdsReportBlock).specificationsOnly, true);
    assert.equal((changes[0] as IdsReportBlock).variant, 'compact');
  });
});
