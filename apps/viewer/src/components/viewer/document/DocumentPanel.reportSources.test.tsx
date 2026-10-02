/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One Add block entry for every validation report, and one source picker (#6553):
 * the saved reports of the Data validation tab (IDS, information validation and
 * manual together) plus the two live sources. Documents saved before the change
 * must load with the same source selected and untouched.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { ValidationReport } from '@ifc-lite/ids';
import { cleanup, click, render } from '@/test/render.js';
import { useViewerStore } from '@/store/index.js';
import { blankDocument } from '@/lib/document/presets';
import { parseDocumentFile } from '@/lib/document/persistence';
import { CHECKLIST_VERSION } from '@/lib/validation/manual/checklist';
import { emptyManualReportBlock } from '@/lib/document/manual-report';
import { newSavedReport, type SavedValidationReport } from '@/lib/validation/reports/history';
import type { DocumentBlock, IdsReportBlock } from '@/lib/document/types';
import type { ManualReportBlock } from '@/lib/document/manual-report-types';
import { DocumentPanel } from './DocumentPanel.js';

const initial = useViewerStore.getState();

const idsBlock: IdsReportBlock = {
  kind: 'ids-report', id: 'snap-ids', sourceKind: 'ids', sourceName: 'Design IDS', generatedAt: '2026-01-15T10:00:00.000Z',
  summary: { checked: 4, passed: 1, failed: 3, passRate: 25 },
  checks: [{ id: 's1', shortDescription: 'Walls', checked: 4, passed: 1, failed: 3, passRate: 25, rules: [] }],
};
const rulesBlock: IdsReportBlock = {
  kind: 'ids-report', id: 'snap-rules', sourceKind: 'rules', sourceName: 'Delivery rules', generatedAt: '2026-01-16T10:00:00.000Z',
  summary: { checked: 2, passed: 2, failed: 0, passRate: 100 },
  checks: [{ id: 'r1', shortDescription: 'Unique names', checked: 2, passed: 2, failed: 0, passRate: 100, rules: [] }],
};
const manualBlock: ManualReportBlock = { ...emptyManualReportBlock('snap-manual', new Date('2026-01-17T10:00:00.000Z')), checklistName: 'Site review' };

const savedIds = (): SavedValidationReport => newSavedReport(idsBlock, 'Saved IDS');
const savedRules = (): SavedValidationReport => newSavedReport(rulesBlock, 'Saved rules');
const savedManual = (): SavedValidationReport => newSavedReport(manualBlock, 'Saved manual');

function liveReport(kind: 'ids' | 'rules'): ValidationReport {
  return {
    source: kind === 'rules' ? { kind: 'rules', ruleSet: { name: 'Live rules' } } : { kind: 'ids', document: { info: { title: 'Live IDS' }, specifications: [] } },
    modelInfo: [], timestamp: new Date('2026-02-01T00:00:00.000Z'),
    summary: { totalSpecifications: 0, passedSpecifications: 0, failedSpecifications: 0, totalEntitiesChecked: 0, totalEntitiesPassed: 0, totalEntitiesFailed: 0, overallPassRate: 0 },
    specificationResults: [],
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}
function openMenu(ui: HTMLElement): void {
  const trigger = [...ui.querySelectorAll('button')].find((b) => b.title === 'Add a block to the page')!;
  act(() => trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })));
  act(() => trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
}
const menuLabels = (): string[] => [...document.body.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent ?? '');
const menuItem = (label: string) => [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === label);
function sourcePicker(ui: HTMLElement): HTMLSelectElement {
  const picker = ui.querySelector<HTMLSelectElement>('select[aria-label="Saved report source"]');
  assert.ok(picker, 'the block offers the one source picker');
  return picker;
}
const pickerLabels = (ui: HTMLElement): string[] => [...sourcePicker(ui).options].map((o) => o.textContent ?? '');
function pick(select: HTMLSelectElement, value: string): void {
  act(() => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });
}
const blocks = (): DocumentBlock[] => useViewerStore.getState().documents[0].blocks;
const refreshLabels = (ui: HTMLElement): string[] => [...ui.querySelectorAll('button')].map((b) => b.textContent ?? '').filter((text) => text.startsWith('Refresh'));

function seedDocument(seed: DocumentBlock[]): void {
  const doc = { ...blankDocument(), blocks: seed };
  useViewerStore.getState().upsertDocument(doc);
  useViewerStore.getState().setActiveDocumentId(doc.id);
}

beforeEach(() => {
  localStorage.clear();
  useViewerStore.setState({
    models: new Map(), activeModelId: null, documents: [], activeDocumentId: null, dashboards: [], bcfProject: null,
    savedValidationReports: [], idsValidationReport: null, validationSource: null, manualChecklist: null,
  });
});
afterEach(() => {
  cleanup();
  useViewerStore.setState(initial);
});

describe('Add block menu has one validation report entry (#6553)', () => {
  it('replaces the separate IDS, information validation, saved and manual entries', async () => {
    useViewerStore.setState({ savedValidationReports: [savedIds(), savedRules(), savedManual()], idsValidationReport: liveReport('ids') });
    useViewerStore.getState().setManualChecklist({ version: CHECKLIST_VERSION, name: 'Site review', groups: [] });
    const ui = render(<DocumentPanel />);
    await settle();
    openMenu(ui);
    const labels = menuLabels();
    assert.deepEqual(labels.filter((label) => /validation|report/i.test(label)), ['Validation report']);
  });

  for (const [name, entries, expectedKind, expectedSource] of [
    ['IDS', [savedIds()], 'ids-report', 'ids'],
    ['information validation', [savedRules()], 'ids-report', 'rules'],
    ['manual', [savedManual()], 'manual-report', undefined],
  ] as const) {
    it(`adds a saved ${name} report as the right block, with the one source picker`, async () => {
      useViewerStore.setState({ savedValidationReports: [...entries] });
      const ui = render(<DocumentPanel />);
      await settle();
      openMenu(ui);
      click(menuItem('Validation report')!);
      await settle();
      const added = blocks().at(-1)!;
      assert.equal(added.kind, expectedKind);
      if (added.kind === 'ids-report') assert.equal(added.sourceKind, expectedSource);
      assert.equal((added as IdsReportBlock | ManualReportBlock).savedReportId, entries[0].id, 'the block points at the saved report it was built from');
      assert.equal(sourcePicker(ui).value, entries[0].id, 'the picker shows that saved report');
    });
  }

  it('adds the latest saved report when saved reports and live sources both exist', async () => {
    const older = savedIds();
    const latest = savedRules();
    useViewerStore.setState({ savedValidationReports: [older, latest], idsValidationReport: liveReport('ids') });
    const ui = render(<DocumentPanel />);
    await settle();
    openMenu(ui);
    click(menuItem('Validation report')!);
    await settle();
    const added = blocks().at(-1) as IdsReportBlock;
    assert.equal(added.savedReportId, latest.id);
    assert.equal(added.sourceName, 'Delivery rules');
  });

  it('is enabled by a saved report, a live run or a manual checklist alone, and disabled with none of them', async () => {
    const enabledWith = async (setup: () => void): Promise<boolean> => {
      cleanup();
      useViewerStore.setState({ documents: [], activeDocumentId: null, savedValidationReports: [], idsValidationReport: null });
      act(() => setup());
      const ui = render(<DocumentPanel />);
      await settle();
      openMenu(ui);
      return menuItem('Validation report')?.hasAttribute('data-disabled') === false;
    };
    assert.equal(await enabledWith(() => {}), false, 'nothing to add');
    assert.equal(await enabledWith(() => useViewerStore.setState({ savedValidationReports: [savedManual()] })), true, 'a saved report');
    assert.equal(await enabledWith(() => useViewerStore.setState({ idsValidationReport: liveReport('rules') })), true, 'a live run');
    assert.equal(await enabledWith(() => useViewerStore.getState().setManualChecklist({ version: CHECKLIST_VERSION, name: 'Site review', groups: [] })), true, 'a manual checklist');
  });
});

describe('the block source picker covers every kind and both live sources (#6553)', () => {
  it('lists every saved report whatever its kind, plus the live sources that exist', async () => {
    useViewerStore.setState({ savedValidationReports: [savedIds(), savedRules(), savedManual()], idsValidationReport: liveReport('rules') });
    useViewerStore.getState().setManualChecklist({ version: CHECKLIST_VERSION, name: 'Site review', groups: [] });
    seedDocument([{ ...idsBlock, id: 'b1' }]);
    const ui = render(<DocumentPanel />);
    await settle();
    const labels = pickerLabels(ui);
    assert.ok(labels.some((l) => l.startsWith('Saved IDS')) && labels.some((l) => l.startsWith('Saved rules')) && labels.some((l) => l.startsWith('Saved manual')), 'saved reports of all three kinds');
    assert.ok(labels.includes('Current information validation run (live)'), 'the live run, named for its kind');
    assert.ok(labels.includes('Current manual checklist (live)'));
  });

  it('offers no live option for a source that does not exist', async () => {
    useViewerStore.setState({ savedValidationReports: [savedIds()] });
    seedDocument([{ ...idsBlock, id: 'b1' }]);
    const ui = render(<DocumentPanel />);
    await settle();
    assert.deepEqual(pickerLabels(ui).filter((l) => l.includes('(live)')), []);
  });

  it('switches a block between kinds keeping its id, title and scale, and a live choice shows Refresh', async () => {
    const entries = [savedIds(), savedManual()];
    useViewerStore.setState({ savedValidationReports: entries, idsValidationReport: liveReport('ids') });
    seedDocument([{ ...idsBlock, id: 'b1', savedReportId: entries[0].id, title: 'Authored', scale: 1.5 }]);
    const ui = render(<DocumentPanel />);
    await settle();
    assert.deepEqual(refreshLabels(ui), [], 'saved evidence has no refresh');

    pick(sourcePicker(ui), entries[1].id);
    await settle();
    const manual = blocks()[0] as ManualReportBlock;
    assert.equal(manual.kind, 'manual-report');
    assert.deepEqual([manual.id, manual.title, manual.scale, manual.savedReportId], ['b1', 'Authored', 1.5, entries[1].id]);

    pick(sourcePicker(ui), 'live:ids');
    await settle();
    const live = blocks()[0] as IdsReportBlock;
    assert.equal(live.kind, 'ids-report');
    assert.deepEqual([live.id, live.title, live.scale, live.savedReportId, live.sourceName], ['b1', 'Authored', 1.5, undefined, 'Live IDS']);
    assert.deepEqual(refreshLabels(ui), ['Refresh from current validation report'], 'the live block can refresh again');
  });

  it('keeps the compact specifications-only choice when the source changes between IDS reports', async () => {
    const entries = [savedIds(), savedRules()];
    useViewerStore.setState({ savedValidationReports: entries, idsValidationReport: liveReport('ids') });
    seedDocument([{ ...idsBlock, id: 'b1', savedReportId: entries[0].id, variant: 'compact', specificationsOnly: true }]);
    const ui = render(<DocumentPanel />);
    await settle();
    pick(sourcePicker(ui), entries[1].id);
    await settle();
    assert.equal((blocks()[0] as IdsReportBlock).specificationsOnly, true, 'a saved report keeps it');
    pick(sourcePicker(ui), 'live:ids');
    await settle();
    assert.deepEqual([(blocks()[0] as IdsReportBlock).specificationsOnly, (blocks()[0] as IdsReportBlock).variant], [true, 'compact'], 'the live run keeps it too');
  });

  it('moves a saved block to the live manual checklist, which then shows its own refresh', async () => {
    const entries = [savedIds()];
    useViewerStore.setState({ savedValidationReports: entries });
    useViewerStore.getState().setManualChecklist({ version: CHECKLIST_VERSION, name: 'Site review', groups: [] });
    seedDocument([{ ...idsBlock, id: 'b1', savedReportId: entries[0].id, title: 'Authored' }]);
    const ui = render(<DocumentPanel />);
    await settle();
    pick(sourcePicker(ui), 'live:manual');
    await settle();
    const live = blocks()[0] as ManualReportBlock;
    assert.equal(live.kind, 'manual-report');
    assert.deepEqual([live.id, live.title, live.savedReportId, live.checklistName], ['b1', 'Authored', undefined, 'Site review']);
    assert.deepEqual(refreshLabels(ui), ['Refresh from current checklist']);
  });
});

describe('documents saved before the change keep their source (#6553)', () => {
  it('each existing report source loads with the same selection, controls and untouched content', async () => {
    const entries = [savedIds(), savedRules(), savedManual()];
    useViewerStore.setState({ savedValidationReports: entries, idsValidationReport: liveReport('ids') });
    const before: DocumentBlock[] = [
      { ...idsBlock, id: 'live-ids' },
      { ...rulesBlock, id: 'live-rules' },
      { ...idsBlock, id: 'saved-ids', savedReportId: entries[0].id },
      { ...rulesBlock, id: 'saved-rules', savedReportId: entries[1].id },
      { ...manualBlock, id: 'saved-manual', savedReportId: entries[2].id },
    ];
    const reopened = parseDocumentFile(JSON.stringify({ ...blankDocument(), blocks: before }));
    useViewerStore.getState().upsertDocument(reopened);
    useViewerStore.getState().setActiveDocumentId(reopened.id);
    const ui = render(<DocumentPanel />);
    await settle();

    const editors = [...ui.querySelectorAll('[data-block-editor]')];
    assert.equal(editors.length, 5);
    const pickerValue = (editor: Element): string | undefined => editor.querySelector<HTMLSelectElement>('select[aria-label="Saved report source"]')?.value;
    assert.deepEqual(editors.map(pickerValue), ['', '', entries[0].id, entries[1].id, entries[2].id], 'live blocks keep no saved selection, saved blocks keep theirs');
    assert.deepEqual(editors.map((e) => [...e.querySelectorAll('button')].some((b) => b.textContent?.startsWith('Refresh'))), [true, true, false, false, false], 'live blocks keep Refresh; saved evidence has none');
    assert.deepEqual(useViewerStore.getState().documents[0].blocks, reopened.blocks, 'mounting the panel rewrites nothing');
    const withoutId = (list: DocumentBlock[]) => list.map(({ id: _id, ...rest }) => rest);
    assert.deepEqual(withoutId(reopened.blocks), withoutId(before), 'import keeps every field of every block (it only issues fresh block ids)');
  });
});
