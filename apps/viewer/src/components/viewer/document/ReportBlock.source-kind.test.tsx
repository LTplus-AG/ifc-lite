/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The report block's two source kinds in the UI (#6372): IDS and information
 * validation share the store's one `idsValidationReport` slot, so the add menu,
 * the block editor's badge and refresh button, and the preview must each read
 * the kind — and refresh must refuse a report of the other kind.
 */
import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { SpecificationResult, ValidationReport } from '@ifc-lite/ids';
import { cleanup, click, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { useViewerStore } from '@/store/index.js';
import type { BindingContext } from '@/lib/document/bindings';
import type { DocumentBlock, IdsReportBlock } from '@/lib/document/types';
import { BlockEditor } from './BlockEditor.js';
import { DocumentPanel } from './DocumentPanel.js';
import { IdsReportPreview } from './IdsReportPreview.js';

// Assertions compare booleans/strings, never DOM nodes: a failing assert on an
// element makes node inspect the whole happy-dom graph (tens of GB).
const BINDINGS: BindingContext = { models: [], activeModelId: null, today: new Date(0) };
const noop = (): void => {};

function result(id: string, name: string, extra: Partial<SpecificationResult> = {}): SpecificationResult {
  return { specification: { id, name }, status: 'fail', applicableCount: 4, passedCount: 1, failedCount: 3, passRate: 25, entityResults: [], ...extra };
}

function liveReport(kind: 'ids' | 'rules'): ValidationReport {
  return {
    source: kind === 'rules'
      ? { kind: 'rules', ruleSet: { name: 'Delivery rules' } }
      : { kind: 'ids', document: { info: { title: 'Design IDS' }, specifications: [] } },
    modelInfo: [],
    timestamp: new Date('2026-02-01T00:00:00.000Z'),
    summary: { totalSpecifications: 0, passedSpecifications: 0, failedSpecifications: 0, totalEntitiesChecked: 0, totalEntitiesPassed: 0, totalEntitiesFailed: 0, overallPassRate: 0 },
    specificationResults: [result('r1', 'Rule one', kind === 'rules' ? { specification: { id: 'r1', name: 'Rule one', severity: 'warning' } } : {})],
  };
}

const rulesBlock: IdsReportBlock = {
  kind: 'ids-report', id: 'b-rules', sourceKind: 'rules', sourceName: 'Delivery rules', generatedAt: '2026-01-15T10:00:00.000Z',
  summary: { checked: 9, passed: 4, failed: 2, passRate: 44, warnings: 3 },
  checks: [
    { id: 'u', shortDescription: 'Unique names', checked: 3, passed: 1, failed: 2, passRate: 33, rules: [],
      sets: [{ label: 'Office', actual: 'Office (2×)', expected: 'unique', passed: false }, { label: 'count()', groupKey: '', actual: '2', expected: '>= 3', passed: false }] },
    { id: 'c', shortDescription: 'Enough spaces', checked: 3, passed: 0, failed: 3, passRate: 0, rules: [], severity: 'warning',
      cardinality: { passed: false, actual: 3, min: 4 } },
    { id: 'x', shortDescription: 'Broken rule', checked: 0, passed: 0, failed: 0, passRate: 0, rules: [], error: 'unsafe regular expression' },
  ],
};

/** A block saved before #6372: no `sourceKind`. */
const legacyIdsBlock: IdsReportBlock = {
  kind: 'ids-report', id: 'b-ids', sourceName: 'Design IDS', generatedAt: '2026-01-15T10:00:00.000Z',
  summary: { checked: 4, passed: 1, failed: 3, passRate: 25 },
  checks: [{ id: 's1', shortDescription: 'Walls', checked: 4, passed: 1, failed: 3, passRate: 25, rules: [] }],
};

function refreshButton(ui: HTMLElement): HTMLButtonElement {
  const button = [...ui.querySelectorAll('button')].find((b) => b.textContent?.includes('Refresh from current validation report'));
  assert.ok(button, 'the refresh button is present');
  return button as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('report block preview (#6372)', () => {
  it('heads an information validation block with its own label, and shows warnings, set rows, cardinality and errors', () => {
    const ui = render(<IdsReportPreview block={rulesBlock} />);
    const text = ui.textContent ?? '';
    assert.ok(text.includes('Information validation report: Delivery rules'));
    assert.equal(text.includes('IDS report'), false);
    assert.ok(text.includes('Warnings3'), 'a separate Warnings stat');
    assert.ok(ui.querySelector('[data-ids-report-check="c"] [data-ids-report-warning]'), 'the warning rule is tagged');
    assert.equal(ui.querySelector('[data-ids-report-check="u"] [data-ids-report-warning]') !== null, false, 'an error rule is not');
    const setRows = [...ui.querySelectorAll('[data-ids-report-check="u"] [data-ids-report-set]')].map((row) => row.textContent);
    assert.deepEqual(setRows, ['OfficeOffice (2×) · expected unique · Failed', 'count() · (blank)2 · expected >= 3 · Failed'], 'a blank group is named, not dropped (#6372 review)');
    assert.equal(ui.querySelector('[data-ids-report-check="c"] [data-ids-report-cardinality]')?.textContent, 'Applicable elementsFound 3 · expected at least 4 · Not met');
    const broken = ui.querySelector('[data-ids-report-check="x"]');
    assert.equal(broken?.querySelector('[data-ids-report-error]')?.textContent, 'Could not be evaluated: unsafe regular expression');
    assert.equal(broken?.textContent?.includes('0%'), false, 'no 0/0/0% for an unevaluated rule');
  });

  it('reads a block saved without sourceKind as IDS, with no warnings stat', () => {
    const ui = render(<IdsReportPreview block={legacyIdsBlock} />);
    assert.ok(ui.textContent?.includes('IDS report: Design IDS'));
    assert.equal(ui.textContent?.includes('Warnings'), false);
  });

  it('routes the new preview strings through the catalogue', () => {
    const ui = render(<IdsReportPreview block={rulesBlock} />);
    const catalogue: Catalogue = {
      'document.preview.rulesReportHeading': 'Informationsprüfbericht: {name}',
      'document.preview.idsReportWarnings': 'Warnungen',
      'document.preview.idsReportWarningTag': 'Warnung',
      'document.preview.idsReportError': 'Nicht auswertbar: {error}',
      'document.preview.idsReportCardinality': 'Anwendbare Elemente',
    };
    registerLocale('de-x-rpt6372', catalogue);
    act(() => setLocale('de-x-rpt6372'));
    const text = ui.textContent ?? '';
    assert.ok(text.includes('Informationsprüfbericht: Delivery rules'));
    assert.ok(text.includes('Warnungen'));
    assert.equal(ui.querySelector('[data-ids-report-warning]')?.textContent, 'Warnung');
    assert.ok(text.includes('Nicht auswertbar: unsafe regular expression'));
    assert.ok(text.includes('Anwendbare Elemente'));
  });
});

describe('report block editor refresh (#6372)', () => {
  function editor(block: IdsReportBlock, report: ValidationReport | null, onChange: (b: DocumentBlock) => void = noop) {
    return render(<BlockEditor block={block} index={0} count={1} bindings={BINDINGS} topics={new Map()} charts={[]} idsValidationReport={report} onChange={onChange} onMove={noop} onCopy={noop} onRemove={noop} />);
  }

  it('labels an information validation block by its kind', () => {
    const ui = editor(rulesBlock, null);
    assert.ok(ui.querySelector('[data-block-editor]')?.textContent?.includes('Information validation report'));
    assert.equal(ui.querySelector('[data-block-editor]')?.textContent?.includes('IDS report'), false);
  });

  it('refuses an IDS report for an information validation block, and takes a rule-set report', () => {
    const refused = editor(rulesBlock, liveReport('ids'));
    assert.equal(refreshButton(refused).disabled, true);
    assert.equal(refreshButton(refused).title, 'Run an information validation first');
    cleanup();

    const changes: DocumentBlock[] = [];
    const accepted = editor(rulesBlock, liveReport('rules'), (b) => changes.push(b));
    assert.equal(refreshButton(accepted).disabled, false);
    click(refreshButton(accepted));
    assert.equal(changes.length, 1);
    const refreshed = changes[0] as IdsReportBlock;
    assert.equal(refreshed.id, 'b-rules', 'refresh keeps the block id');
    assert.equal(refreshed.sourceKind, 'rules');
    assert.equal(refreshed.checks[0].severity, 'warning');
  });

  it('refuses a rule-set report for a block saved without sourceKind (an IDS block), and takes an IDS report', () => {
    const refused = editor(legacyIdsBlock, liveReport('rules'));
    assert.equal(refreshButton(refused).disabled, true);
    assert.equal(refreshButton(refused).title, 'Run an IDS validation first');
    cleanup();

    const changes: DocumentBlock[] = [];
    const accepted = editor(legacyIdsBlock, liveReport('ids'), (b) => changes.push(b));
    click(refreshButton(accepted));
    assert.equal((changes[0] as IdsReportBlock).sourceKind, 'ids');
    assert.equal((changes[0] as IdsReportBlock).sourceName, 'Design IDS');
  });
});

describe('report block add menu (#6372)', () => {
  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
  }
  function openMenu(ui: HTMLElement): void {
    const trigger = [...ui.querySelectorAll('button')].find((b) => b.title === 'Add a block to the page')!;
    act(() => trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })));
    act(() => trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
  }
  const menuItem = (label: string) => [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === label);

  beforeEach(() => {
    useViewerStore.setState({
      models: new Map(), activeModelId: null, documents: [], activeDocumentId: null, dashboards: [],
      bcfProject: null, selectedEntityIds: new Set(), idsValidationReport: null, validationSource: null,
    });
  });

  it('adds a block of the rule-set kind from a rule-set run through the one validation report entry (#6372, #6553)', async () => {
    useViewerStore.setState({ idsValidationReport: liveReport('rules'), validationSource: 'rules' });
    const ui = render(<DocumentPanel />);
    await settle();
    openMenu(ui);
    assert.equal(menuItem('IDS validation report') !== undefined, false, 'no separate IDS item');
    assert.equal(menuItem('Information validation report') !== undefined, false, 'no separate information validation item');
    const item = menuItem('Validation report');
    assert.ok(item, 'the menu names the one validation report entry');
    click(item!);
    await settle();
    const added = useViewerStore.getState().documents[0].blocks.find((b): b is IdsReportBlock => b.kind === 'ids-report');
    assert.equal(added?.sourceKind, 'rules');
    assert.ok(ui.querySelector('[data-block-ids-report]')?.textContent?.includes('Information validation report: Delivery rules'));
  });

  it('adds an IDS block from an IDS run, and the entry is disabled naming every source with nothing to add (#6553)', async () => {
    useViewerStore.setState({ idsValidationReport: liveReport('ids'), validationSource: 'ids' });
    const ui = render(<DocumentPanel />);
    await settle();
    openMenu(ui);
    assert.equal(menuItem('Validation report')?.hasAttribute('data-disabled'), false);
    click(menuItem('Validation report')!);
    await settle();
    assert.equal(useViewerStore.getState().documents[0].blocks.find((b): b is IdsReportBlock => b.kind === 'ids-report')?.sourceKind, 'ids');
    cleanup();

    useViewerStore.setState({ idsValidationReport: null, validationSource: null, documents: [], activeDocumentId: null });
    const empty = render(<DocumentPanel />);
    await settle();
    openMenu(empty);
    const disabled = menuItem('Validation report');
    assert.ok(disabled);
    assert.equal(disabled?.getAttribute('title'), 'Save a report under Data validation, run a validation, or create a manual checklist first');
    assert.equal(disabled?.hasAttribute('data-disabled'), true);
  });
});
