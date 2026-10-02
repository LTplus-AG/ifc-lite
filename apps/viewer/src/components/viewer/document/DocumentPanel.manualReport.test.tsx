/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Add block › Validation report" with the manual checklist as its source (#6401) in the real Document panel:
 * the block snapshots the Manual validation tab's checklist and the active
 * model's answers, the preview shows the rings and every verdict, and the
 * snapshot stays frozen until Refresh.
 */

import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel } from '@/test/store-fixture.js';
import { cleanup, click, render, type as typeInput } from '@/test/render.js';
import { CHECKLIST_VERSION } from '@/lib/validation/manual/checklist';
import { parseDocumentFile } from '@/lib/document/persistence';
import type { ManualReportBlock } from '@/lib/document/manual-report-types';
import { DocumentPanel } from './DocumentPanel.js';

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}

function openMenu(trigger: Element): void {
  act(() => trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })));
  act(() => trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
}

function menuItem(text: string): HTMLElement | undefined {
  return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes(text));
}

const MINI_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'Tower',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

async function parsedModel(id: string, name: string, sourceFingerprint: string): Promise<FederatedModel> {
  const bytes = new TextEncoder().encode(MINI_IFC);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return { ...fixtureModel(id), name, sourceFingerprint, ifcDataStore: store, maxExpressId: 2 } as FederatedModel;
}
const towerModel = async (): Promise<Promise<FederatedModel>> => (await parsedModel('m1', 'tower.ifc', 'fp-tower'));
const initial = useViewerStore.getState();

beforeEach(async () => {
  localStorage.clear();
  const model = await towerModel();
  useViewerStore.setState({
    models: new Map([[model.id, model]]),
    activeModelId: model.id,
    documents: [],
    activeDocumentId: null,
    dashboards: [],
    bcfProject: null,
  });
  useViewerStore.getState().setManualChecklist({
      version: CHECKLIST_VERSION,
      name: 'Coordination round 3',
      groups: [{ id: 'g', name: 'Delivery', items: [{ id: 'a', text: 'Uploaded on time' }, { id: 'b', text: 'Naming convention' }] }],
  });
  useViewerStore.getState().setManualAnswer('fp-tower', 'a', { status: 'pass' });
  useViewerStore.getState().setManualAnswer('fp-tower', 'b', { status: 'warning', comment: 'Old prefix' });
});

afterEach(() => {
  cleanup();
  useViewerStore.setState({ ...initial, models: new Map(), manualChecklist: null, manualAnswers: {} });
});

describe('Document panel manual validation report (#6401)', () => {
  for (const modelsCount of [1, 2]) it(`toggles stamp preview, preserves it through refresh/history and reopens recorded evidence at ${modelsCount} model(s) (#6566)`, async () => {
    if (modelsCount === 2) {
      const tower = useViewerStore.getState().models.get('m1')!;
      const annex = await parsedModel('m2', 'annex.ifc', 'fp-annex');
      act(() => useViewerStore.setState({ models: new Map([['m1', tower], ['m2', annex]]), activeModelId: 'm2' }));
      useViewerStore.getState().setManualAnswer('fp-annex', 'a', { status: 'fail' });
      useViewerStore.getState().setManualAnswer('fp-annex', 'b', { status: 'warning', comment: 'Annex observation' });
    }
    const ui = render(<DocumentPanel />);
    await settle();
    openMenu([...ui.querySelectorAll('button')].find((button) => button.title === 'Add a block to the page')!);
    click(menuItem('Validation report')!);
    await settle();
    const stored = (): ManualReportBlock => useViewerStore.getState().documents[0].blocks.find((candidate): candidate is ManualReportBlock => candidate.kind === 'manual-report')!;
    const preview = (): Element => ui.querySelector('[data-block-manual-report]')!;
    const stampControl = (): HTMLInputElement | undefined => [...ui.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.closest('label')?.textContent?.trim() === 'Show stamp information');
    const frozen = structuredClone(stored());
    assert.match(preview().textContent ?? '', /Model:.*Recorded:/);
    assert.ok(preview().querySelector('[data-report-model-scope]'));
    const checkbox = stampControl();
    assert.ok(checkbox, 'manual report offers its own stamp visibility control');
    assert.equal(checkbox.checked, true, 'existing blocks display their original stamp');
    click(checkbox);
    await settle();
    assert.ok(!/Model:|Models:|Recorded:/.test(preview().textContent ?? ''), 'both stamp rows disappear from the page');
    assert.equal(preview().querySelector('[data-report-model-scope]'), null);
    assert.match(preview().textContent ?? '', /Manual validation: Coordination round 3/);
    assert.deepEqual([...preview().querySelectorAll('li[data-status]')].map((item) => item.getAttribute('data-status')), frozen.groups[0].items.map((item) => item.status));
    const { showStamp: _stamp, ...hiddenEvidence } = Object.assign({}, stored(), { showStamp: 'showStamp' in stored() ? stored().showStamp : undefined });
    assert.deepEqual(hiddenEvidence, frozen, 'the control changes presentation only');
    const imported = parseDocumentFile(JSON.stringify(useViewerStore.getState().documents[0]));
    const reopened = imported.blocks.find((candidate): candidate is ManualReportBlock => candidate.kind === 'manual-report')!;
    assert.equal('showStamp' in reopened ? reopened.showStamp : undefined, false);
    assert.equal(reopened.generatedAt, frozen.generatedAt);
    assert.deepEqual(reopened.reportModels, frozen.reportModels);
    assert.deepEqual(reopened.groups, frozen.groups);

    act(() => useViewerStore.getState().setManualAnswer(frozen.modelFingerprint!, 'b', { status: 'pass' }));
    click([...ui.querySelectorAll('button')].find((button) => button.textContent === 'Refresh from current checklist')!);
    await settle();
    assert.equal(stampControl()!.checked, false, 'live Refresh retains the stamp choice');
    assert.equal(stored().groups[0].items[1].status, 'pass');
    assert.ok(!/Model:|Models:|Recorded:/.test(preview().textContent ?? ''));
    let savedId: string | null = null;
    (await act(async () => { savedId = (await useViewerStore.getState().saveValidationReport(Object.assign({}, stored(), { checklistName: 'Later review', showStamp: true }), 'Later review')); }));
    assert.ok(savedId);
    const source = ui.querySelector<HTMLSelectElement>('select[aria-label="Saved report source"]');
    assert.ok(source);
    act(() => { source.value = savedId!; source.dispatchEvent(new window.Event('change', { bubbles: true })); });
    await settle();
    assert.equal(stored().checklistName, 'Later review');
    assert.equal(stampControl()!.checked, false, 'choosing frozen evidence retains the stamp choice');
    const selectedGroups = structuredClone(stored().groups);
    click(stampControl()!);
    await settle();
    assert.match(preview().textContent ?? '', /Model:.*Recorded:/);
    assert.ok(preview().querySelector('[data-report-model-scope]'));
    assert.deepEqual(stored().groups, selectedGroups, 'showing the stamp never modifies the selected answers');
  });

  it('adds a frozen snapshot of the checklist and the active model\'s answers, and Refresh re-takes it', async () => {
    const ui = render(<DocumentPanel />);
    await settle();
    openMenu([...ui.querySelectorAll('button')].find((b) => b.title === 'Add a block to the page')!);
    const item = menuItem('Validation report');
    assert.ok(item, 'the menu offers the one validation report entry');
    click(item);
    await settle();

    const stored = (): ManualReportBlock => useViewerStore.getState().documents[0].blocks.find((b): b is ManualReportBlock => b.kind === 'manual-report')!;
    assert.equal(stored().modelName, 'tower.ifc');
    assert.deepEqual(stored().summary, { total: 2, pass: 1, fail: 0, warning: 1, unanswered: 0 });

    const preview = ui.querySelector('[data-block-manual-report]')!;
    assert.match(preview.textContent ?? '', /Manual validation: Coordination round 3/);
    assert.deepEqual([...preview.querySelectorAll('li[data-status]')].map((li) => li.getAttribute('data-status')), ['pass', 'warning']);
    assert.ok(preview.querySelector('svg[aria-label="Overall: 1 passed, 1 with warnings, 0 failed, 0 not checked"]'));
    assert.match(preview.textContent ?? '', /Old prefix/);

    // Authored headings survive a real checklist refresh (#6547 review).
    const title = ui.querySelector<HTMLInputElement>(`[data-block-editor="${stored().id}"] input[aria-label="Block title"]`);
    assert.ok(title);
    typeInput(title, 'Authored manual heading');
    await settle();
    assert.equal(stored().title, 'Authored manual heading');

    // A later answer does not reach the saved block until Refresh.
    act(() => { useViewerStore.getState().setManualAnswer('fp-tower', 'b', { status: 'fail' }); });
    await settle();
    assert.equal(stored().groups[0].items[1].status, 'warning');
    click([...ui.querySelectorAll('button')].find((b) => b.textContent === 'Refresh from current checklist')!);
    await settle();
    assert.equal(stored().title, 'Authored manual heading', 'refresh preserves the heading while replacing checklist evidence');
    assert.match(preview.textContent ?? '', /Authored manual heading/);
    assert.equal(stored().groups[0].items[1].status, 'fail');
    assert.deepEqual(stored().summary, { total: 2, pass: 1, fail: 1, warning: 0, unanswered: 0 });
  });

  // CodeRabbit on #6486: Refresh found the model by display name and fell back to the active
  // one, so it could snapshot another model's answers and still toast success.
  it('Refresh reads the model the block was taken from, and says so instead of reading another when it is not loaded', async () => {
    const tower = useViewerStore.getState().models.get('m1')!;
    const annex = await parsedModel('m2', 'tower.ifc', 'fp-annex'); // same display name, different file
    useViewerStore.setState({
      models: new Map([['m1', tower], ['m2', annex]]),
      activeModelId: 'm2',
    });
    useViewerStore.getState().setManualAnswer('fp-annex', 'a', { status: 'fail' });
    const ui = render(<DocumentPanel />);
    await settle();
    openMenu([...ui.querySelectorAll('button')].find((b) => b.title === 'Add a block to the page')!);
    click(menuItem('Validation report')!);
    await settle();
    const stored = (): ManualReportBlock => useViewerStore.getState().documents[0].blocks.find((b): b is ManualReportBlock => b.kind === 'manual-report')!;
    assert.equal(stored().modelFingerprint, 'fp-annex');
    const refresh = (): HTMLButtonElement => [...ui.querySelectorAll('button')].find((b) => b.textContent === 'Refresh from current checklist')!;

    // Another model becomes active and the annex gains an answer: Refresh still reads the annex.
    act(() => {
      useViewerStore.setState({ activeModelId: 'm1' });
      useViewerStore.getState().setManualAnswer('fp-annex', 'b', { status: 'pass' });
    });
    await settle();
    click(refresh());
    await settle();
    assert.equal(stored().modelFingerprint, 'fp-annex');
    assert.deepEqual(stored().groups[0].items.map((i) => i.status), ['fail', 'pass']);

    // The annex is unloaded: no silent switch to the tower's answers.
    act(() => { useViewerStore.setState({ models: new Map([['m1', tower]]), activeModelId: 'm1' }); });
    await settle();
    assert.match(ui.querySelector('[data-manual-report-model-missing]')?.textContent ?? '', /\(tower\.ifc\) is not loaded/);
    assert.equal(refresh().disabled, true);
    click(refresh());
    await settle();
    assert.equal(stored().modelFingerprint, 'fp-annex');
    assert.deepEqual(stored().groups[0].items.map((i) => i.status), ['fail', 'pass']);

    // An explicit pick re-binds the block to that model.
    // #6485 also offers m1 in text-field sources. Pick the labelled answers
    // control, as a user does, rather than the first select sharing that option.
    const select = [...ui.querySelectorAll('select')].find((el) => el.closest('label')?.textContent?.trim().startsWith('Answers from'));
    assert.ok(select, 'the manual report offers its own answers-model picker');
    act(() => {
      // Through the prototype setter, so React's value tracker sees the change.
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(select, 'm1');
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await settle();
    assert.ok(!ui.querySelector('[data-manual-report-model-missing]'), 'the picked model clears the not-loaded state');
    click(refresh());
    await settle();
    assert.equal(stored().modelFingerprint, 'fp-tower');
    assert.deepEqual(stored().groups[0].items.map((i) => i.status), ['pass', 'warning']);
  });

  it('is unavailable until a checklist exists', async () => {
    const state = useViewerStore.getState();
    state.removeManualChecklist(state.manualLibrary.activeId!);
    const ui = render(<DocumentPanel />);
    await settle();
    openMenu([...ui.querySelectorAll('button')].find((b) => b.title === 'Add a block to the page')!);
    const item = menuItem('Validation report');
    assert.equal(item?.getAttribute('aria-disabled'), 'true');
  });

  for (const modelsCount of [1, 2]) it(`selects an independent checklist without switching Validation, preserves its layout, and retains a deleted-source snapshot at ${modelsCount} model(s) (#6507)`, async () => {
    const architectureId = useViewerStore.getState().manualLibrary.activeId!;
    useViewerStore.getState().renameManualChecklist('Architecture');
    useViewerStore.getState().duplicateManualChecklist(architectureId, 'Structure');
    const structureId = useViewerStore.getState().manualLibrary.activeId!;
    let fingerprint = 'fp-tower';
    if (modelsCount === 2) {
      const tower = useViewerStore.getState().models.get('m1')!;
      const annex = await parsedModel('m2', 'annex.ifc', 'fp-annex');
      useViewerStore.setState({ models: new Map([['m1', tower], ['m2', annex]]), activeModelId: 'm2' });
      fingerprint = 'fp-annex';
    }
    useViewerStore.getState().setManualAnswer(fingerprint, 'a', { status: 'fail' });
    useViewerStore.getState().setManualAnswer(fingerprint, 'b', { status: 'warning', comment: 'Structure-only observation' });
    useViewerStore.getState().selectManualChecklist(architectureId);
    const ui = render(<DocumentPanel />);
    await settle();
    openMenu([...ui.querySelectorAll('button')].find((button) => button.title === 'Add a block to the page')!);
    click(menuItem('Validation report')!);
    await settle();
    const stored = (): ManualReportBlock => useViewerStore.getState().documents[0].blocks.find((block): block is ManualReportBlock => block.kind === 'manual-report')!;
    const blockId = stored().id;
    const choose = async (label: string, value: string) => {
      const select = ui.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
      assert.ok(select);
      act(() => { select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
      await settle();
    };
    await choose('Checklist', structureId);
    assert.equal(useViewerStore.getState().manualLibrary.activeId, architectureId, 'Documentation choice never switches the active Validation editor');
    assert.equal(stored().id, blockId);
    assert.equal(stored().checklistId, structureId);
    assert.equal(stored().modelFingerprint, fingerprint);
    assert.deepEqual(stored().groups[0].items.map((item) => item.status), ['fail', 'warning']);
    assert.match(ui.querySelector('[data-block-manual-report]')?.textContent ?? '', /Structure-only observation/);
    // #6655: both replacement routes retain the destination's entire authored
    // presentation even when the source snapshot has conflicting settings.
    const title = ui.querySelector<HTMLInputElement>(`[data-block-editor="${blockId}"] input[aria-label="Block title"]`);
    assert.ok(title);
    typeInput(title, 'Authored review heading');
    const stamp = [...ui.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.closest('label')?.textContent?.trim() === 'Show stamp information');
    assert.ok(stamp);
    click(stamp);
    await settle();
    await choose('Checklist layout', 'compact');
    const checkbox = [...ui.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.closest('label')?.textContent?.includes('Show benchmark scores'))!;
    assert.ok(checkbox);
    click(checkbox);
    await settle();
    const preview = ui.querySelector('[data-block-manual-report]')!;
    assert.equal(stored().benchmarks, false);
    assert.equal(preview.querySelector('[data-manual-report-benchmarks]'), null);
    assert.ok(!preview.textContent?.includes('Structure-only observation'), 'short layout keeps verdicts while omitting review detail');
    assert.deepEqual([...preview.querySelectorAll('li[data-status]')].map((item) => item.getAttribute('data-status')), ['fail', 'warning']);
    act(() => {
      useViewerStore.getState().selectManualChecklist(structureId);
      useViewerStore.getState().setManualAnswer(fingerprint, 'b', { status: 'pass' });
      useViewerStore.getState().selectManualChecklist(architectureId);
    });
    const refresh = (): HTMLButtonElement => [...ui.querySelectorAll('button')].find((button) => button.textContent === 'Refresh from current checklist')!;
    click(refresh());
    await settle();
    assert.equal(stored().id, blockId);
    assert.equal(stored().checklistId, structureId);
    assert.equal(stored().variant, 'compact');
    assert.equal(stored().benchmarks, false);
    assert.equal(stored().title, 'Authored review heading');
    assert.equal(stored().showStamp, false);
    assert.deepEqual(stored().groups[0].items.map((item) => item.status), ['fail', 'pass']);
    assert.equal(useViewerStore.getState().manualLibrary.activeId, architectureId);
    const frozen = structuredClone(stored());
    act(() => useViewerStore.getState().removeManualChecklist(structureId));
    await settle();
    assert.equal(refresh().disabled, true);
    assert.ok(ui.querySelector('[data-manual-report-checklist-missing]'));
    assert.deepEqual(stored(), frozen);
    assert.match(preview.textContent ?? '', /Authored review heading/);

    // Frozen history source changes use the same presentation contract as
    // live Refresh, even after the originating checklist was deleted (#6507).
    let firstSaved: string | null = null;
    let secondSaved: string | null = null;
    (await act(async () => {
      firstSaved = (await useViewerStore.getState().saveValidationReport(frozen, 'Structure evidence'));
      secondSaved = (await useViewerStore.getState().saveValidationReport({ ...frozen, checklistName: 'Later structure evidence', title: 'Source review heading', variant: 'long', benchmarks: true, showStamp: true }, 'Later evidence'));
    }));
    assert.ok(firstSaved && secondSaved);
    await choose('Saved report source', firstSaved);
    await choose('Saved report source', secondSaved);
    assert.equal(stored().id, blockId);
    assert.equal(stored().variant, 'compact');
    assert.equal(stored().benchmarks, false);
    assert.equal(stored().title, 'Authored review heading');
    assert.equal(stored().showStamp, false);
    assert.equal(stored().checklistName, 'Later structure evidence');
    assert.equal(ui.querySelector('[data-manual-report-benchmarks]'), null);
    assert.ok(!/Model:|Models:|Recorded:/.test(ui.querySelector('[data-block-manual-report]')?.textContent ?? ''));
    assert.equal(refresh(), undefined, 'frozen history has no live Refresh action');
    (await act(async () => (await useViewerStore.getState().removeValidationReport(secondSaved!))));
    await settle();
    assert.equal(stored().checklistName, 'Later structure evidence', 'removing history retains the selected embedded evidence');
  });


  it('a reopened legacy block cannot refresh from an arbitrary stored checklist after the active editor closes (#6507)', async () => {
    const architectureId = useViewerStore.getState().manualLibrary.activeId!;
    useViewerStore.getState().renameManualChecklist('Architecture');
    useViewerStore.getState().duplicateManualChecklist(architectureId, 'Legacy structure');
    useViewerStore.getState().setManualAnswer('fp-tower', 'a', { status: 'fail' });
    const ui = render(<DocumentPanel />);
    await settle();
    const addManual = async () => {
      openMenu([...ui.querySelectorAll('button')].find((button) => button.title === 'Add a block to the page')!);
      click(menuItem('Validation report')!);
      await settle();
    };
    await addManual();
    const originalDocument = useViewerStore.getState().documents[0];
    const legacyBlock = structuredClone(originalDocument.blocks.find((block): block is ManualReportBlock => block.kind === 'manual-report')!);
    delete legacyBlock.checklistId;
    const reopened = parseDocumentFile(JSON.stringify({ ...originalDocument, version: 7, blocks: [legacyBlock] }));
    act(() => {
      useViewerStore.getState().setManualChecklist(null);
      useViewerStore.setState({ documents: [reopened], activeDocumentId: reopened.id });
    });
    await settle();
    const stored = (): ManualReportBlock => useViewerStore.getState().documents[0].blocks.find((block): block is ManualReportBlock => block.kind === 'manual-report')!;
    const refresh = (): HTMLButtonElement => [...ui.querySelectorAll('button')].find((button) => button.textContent === 'Refresh from current checklist')!;
    assert.equal(stored().checklistId, undefined);
    assert.equal(stored().groups[0].items[0].status, 'fail');
    const frozen = structuredClone(stored());
    assert.equal(refresh().disabled, true, 'closing the editor preserves the unavailable legacy source');
    click(refresh());
    await settle();
    assert.deepEqual(stored(), frozen);
    const picker = ui.querySelector<HTMLSelectElement>('select[aria-label="Checklist"]')!;
    act(() => { picker.value = architectureId; picker.dispatchEvent(new window.Event('change', { bubbles: true })); });
    await settle();
    assert.equal(stored().checklistId, architectureId);
    assert.equal(stored().groups[0].items[0].status, 'pass');
    assert.equal(refresh().disabled, false);
    assert.equal(useViewerStore.getState().manualLibrary.activeId, null, 'explicit Documentation binding does not reopen the Validation editor');
    await addManual();
    const added = useViewerStore.getState().documents[0].blocks.at(-1)!;
    assert.equal(added.kind === 'manual-report' ? added.checklistId : null, architectureId, 'new blocks choose an explicit source while the editor remains closed');
    assert.equal(useViewerStore.getState().manualLibrary.activeId, null);
  });

});
