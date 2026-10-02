/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { beforeEach, afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { computeSourceFingerprint } from '@ifc-lite/cache';
import { useViewerStore, type FederatedModel } from '@/store';
import { cleanup, click, render, type as typeInput } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { loadManualLibrary } from '@/lib/validation/manual/persistence';
import { manualLibraryProjection } from '@/lib/validation/manual/library';
import { loadValidationReports } from '@/lib/validation/reports/persistence';
import { setValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { ValidationPanel } from './ValidationPanel.js';
import { useManualReportSource } from '../document/useManualReportSource.js';
import { ManualReportBlockEditor } from '../document/ManualReportBlockEditor.js';
import type { ManualReportBlock } from '@/lib/document/manual-report-types';

const initial = useViewerStore.getState();
const checklist = {
  version: 1 as const, name: 'Delivery review', groups: [{ id: 'delivery', name: 'Delivery', items: [
    { id: 'uploaded', text: 'Uploaded on time', description: 'Check the recorded delivery.' },
    { id: 'names', text: 'Naming convention' },
    { id: 'followup', text: 'Follow-up note' },
  ] }],
};

async function publicModel(id: string, name: string): Promise<FederatedModel> {
  const bytes = readFileSync(new URL('../../../../public/samples/' + name, import.meta.url));
  const buffer = new Uint8Array(bytes).buffer;
  const store = await new IfcParser().parseColumnar(buffer);
  assert.ok(store.entityCount > 400, 'real public authoring-tool IFC is decoded');
  return { ...fixtureModel(id), name, ifcDataStore: store, sourceFingerprint: `${name}:${computeSourceFingerprint(new Uint8Array(buffer)).hex}` };
}

function button(ui: HTMLElement, text: string): HTMLButtonElement {
  const match = [...ui.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === text);
  assert.ok(match, `actual panel offers ${text}`);
  return match;
}
function row(ui: HTMLElement, text: string): HTMLElement {
  const match = [...ui.querySelectorAll<HTMLElement>('[data-testid="manual-check"]')].find(candidate => candidate.textContent?.includes(text));
  assert.ok(match, `editable check ${text} is present`);
  return match;
}
async function settle(): Promise<void> { await act(async () => { await Promise.resolve(); }); }

beforeEach(() => {
  localStorage.clear();
  setValidationSourceChoice(null);
  useViewerStore.setState({ ...initial, models: new Map(), savedValidationReports: [], documents: [], activeDocumentId: null });
  const library = loadManualLibrary().library;
  useViewerStore.setState({ manualLibrary: library, ...manualLibraryProjection(library), manualSaveError: null });
});
afterEach(() => { cleanup(); useViewerStore.setState(initial); setValidationSourceChoice(null); });

async function saveThenReopenHistory(count: number): Promise<{ source: FederatedModel; peer?: FederatedModel; original: string; ui: HTMLElement }> {
  const source = await publicModel('original-runtime-id', 'building-architecture.ifc');
  useViewerStore.setState(fixtureModels(source));
  useViewerStore.getState().setManualChecklist(checklist);
  useViewerStore.getState().setManualAnswer(source.sourceFingerprint!, 'uploaded', { status: 'pass' });
  useViewerStore.getState().setManualAnswer(source.sourceFingerprint!, 'names', { status: 'warning', comment: 'Recorded prefix needs review' });
  useViewerStore.getState().setManualAnswer(source.sourceFingerprint!, 'followup', { status: null, comment: 'Unanswered note must survive' });
  setValidationSourceChoice('manual');
  const previous = render(<ValidationPanel />);
  click(button(previous, 'Save report'));
  assert.equal(loadValidationReports().length, 1, 'actual Save report persisted evidence');
  const original = JSON.stringify(loadValidationReports()[0]);
  cleanup();
  // A saved history entry remains reusable after its live editable instance
  // is removed; a later session has new runtime UUIDs for the same file.
  useViewerStore.getState().removeManualChecklist(useViewerStore.getState().manualLibrary.activeId!);
  const reloaded = { ...source, id: 'reloaded-runtime-id' };
  const peer = count === 2 ? await publicModel('active-peer', 'building-architecture-rev-b.ifc') : undefined;
  const library = loadManualLibrary().library;
  useViewerStore.setState({ ...fixtureModels(reloaded, ...(peer ? [peer] : [])), activeModelId: peer?.id ?? reloaded.id,
    manualLibrary: library, ...manualLibraryProjection(library), savedValidationReports: loadValidationReports() });
  setValidationSourceChoice(null);
  const ui = render(<ValidationPanel />);
  const history = ui.querySelector<HTMLDetailsElement>('[data-saved-validation-reports]');
  assert.ok(history); act(() => { history.open = true; });
  await settle();
  return { source: reloaded, peer, original, ui };
}

describe('Saved manual report editable reuse (#6611)', () => {
  for (const count of [1, 2]) it(`restores a new editable copy on the recorded model after history-only reopen at ${count} model(s)`, async () => {
    const { source, peer, original, ui } = await saveThenReopenHistory(count);
    click(button(ui, 'Edit a copy'));
    await settle();
    assert.equal(ui.querySelector('[role="tab"][data-state="active"]')?.textContent, 'Manual validation');
    assert.equal(row(ui, 'Uploaded on time').dataset.status, 'pass');
    assert.equal(row(ui, 'Naming convention').dataset.status, 'warning');
    assert.equal(row(ui, 'Follow-up note').dataset.status, 'unanswered');
    const comment = row(ui, 'Naming convention').querySelector<HTMLTextAreaElement>('textarea');
    assert.ok(comment); assert.equal(comment.value, 'Recorded prefix needs review');
    const unanswered = row(ui, 'Follow-up note').querySelector<HTMLTextAreaElement>('textarea');
    assert.ok(unanswered); assert.equal(unanswered.value, 'Unanswered note must survive');
    assert.equal(useViewerStore.getState().manualChecklist?.groups[0].items[0].description, checklist.groups[0].items[0].description);
    if (peer) {
      const picker = ui.querySelector<HTMLSelectElement>('select[aria-label="Model"]');
      assert.ok(picker); assert.equal(picker.value, source.id, 'recorded fingerprint selects its new UUID, never the active peer');
    }
    typeInput(comment, 'Edited current copy');
    click(button(row(ui, 'Naming convention'), 'Pass'));
    assert.equal(row(ui, 'Naming convention').dataset.status, 'pass');
    assert.equal(JSON.stringify(loadValidationReports()[0]), original, 'editing never changes frozen saved evidence');
    const library = loadManualLibrary().library;
    const restored = manualLibraryProjection(library);
    assert.equal(restored.manualAnswers[source.sourceFingerprint!].names.status, 'pass');
    assert.equal(restored.manualAnswers[source.sourceFingerprint!].names.comment, 'Edited current copy');
    assert.equal(peer ? restored.manualAnswers[peer.sourceFingerprint!] : undefined, undefined, 'no answer leaks onto a peer');
    cleanup();
    useViewerStore.setState({ manualLibrary: library, ...restored });
    const reopened = render(<ValidationPanel />);
    assert.equal(row(reopened, 'Naming convention').dataset.status, 'pass', 'canonical library reload retains the editable answer');
    assert.equal(row(reopened, 'Naming convention').querySelector<HTMLTextAreaElement>('textarea')?.value, 'Edited current copy');
  });

  // The canonical primary loader can expose a fingerprint before final
  // registration, and retain it after a failed load (review r4162312272).
  for (const count of [1, 2]) {
    for (const loadState of ['pending', 'streaming-geometry', 'hydrating-metadata', 'error'] as const) {
      it(`refuses ${loadState} source reuse in UI and store at ${count} model(s) (#6611)`, async () => {
        const { source, original, ui } = await saveThenReopenHistory(count);
        const before = localStorage.getItem('ifc-lite:validation:manual-library');
        // A ready active peer cannot grant readiness to the recorded source.
        act(() => useViewerStore.getState().updateModel(source.id, { loadState }));
        await settle();
        assert.equal(button(ui, 'Edit a copy').disabled, true);
        assert.match(ui.textContent ?? '', /load the recorded model/i);
        const saved = useViewerStore.getState().savedValidationReports[0];
        assert.equal(useViewerStore.getState().reuseManualValidationReport(saved), false,
          'canonical store independently refuses a direct or stale-UI attempt');
        assert.equal(localStorage.getItem('ifc-lite:validation:manual-library'), before);
        assert.equal(useViewerStore.getState().manualLibrary.checklists.length, 0);
        assert.equal(JSON.stringify(loadValidationReports()[0]), original);
        act(() => useViewerStore.getState().updateModel(source.id, { loadState: 'complete' }));
        await settle();
        assert.equal(button(ui, 'Edit a copy').disabled, false, 'same fingerprint becomes reusable only at completion');
        click(button(ui, 'Edit a copy'));
        assert.equal(row(ui, 'Naming convention').dataset.status, 'warning');
        assert.equal(JSON.stringify(loadValidationReports()[0]), original);
      });
    }
    for (const loadState of ['complete', undefined] as const) {
      it(`recovers ${loadState ?? 'legacy undefined'} readiness at ${count} model(s) (#6611)`, async () => {
        const { source, original, ui } = await saveThenReopenHistory(count);
        // Individual phase flags can remain opening/idle after unified
        // completion; they are not an additional recovery readiness contract.
        act(() => useViewerStore.getState().updateModel(source.id, {
          loadState, geometryLoadState: 'opening', metadataLoadState: 'idle',
        }));
        await settle();
        assert.equal(button(ui, 'Edit a copy').disabled, false);
        click(button(ui, 'Edit a copy'));
        assert.equal(row(ui, 'Naming convention').dataset.status, 'warning');
        assert.equal(row(ui, 'Naming convention').querySelector<HTMLTextAreaElement>('textarea')?.value, 'Recorded prefix needs review');
        assert.equal(useViewerStore.getState().manualLibrary.checklists[0].preferredModelFingerprint, source.sourceFingerprint);
        assert.equal(JSON.stringify(loadValidationReports()[0]), original);
      });
    }
  }

  for (const loadState of ['pending', 'error'] as const) {
    it(`defaults a recovered copy to the completed identical-file model instead of the first ${loadState} copy (#6611)`, async () => {
      const { source, original, ui } = await saveThenReopenHistory(2);
      const complete = { ...await publicModel('completed-identical-file', 'building-architecture.ifc'), name: 'Completed identical-file instance' };
      assert.equal(complete.sourceFingerprint, source.sourceFingerprint, 'actual same IFC bytes produce the same durable identity');
      act(() => {
        useViewerStore.getState().updateModel(source.id, { loadState });
        useViewerStore.getState().addModel({ ...complete, loadState: 'complete' });
      });
      await settle();
      assert.equal(button(ui, 'Edit a copy').disabled, false, 'another completed copy of the exact source is usable');
      click(button(ui, 'Edit a copy'));
      assert.equal(ui.querySelector<HTMLSelectElement>('select[aria-label="Model"]')?.value, complete.id);
      assert.equal(row(ui, 'Naming convention').dataset.status, 'warning');
      assert.equal(JSON.stringify(loadValidationReports()[0]), original);
      cleanup();
      const refreshed: { value: ManualReportBlock | null } = { value: null };
      function ReadySourceProbe() {
        const handle = useManualReportSource();
        const block = handle.snapshot('recovered-document');
        return <>
          <output data-recovered-document-source>{handle.defaultModelId}</output>
          {block && <ManualReportBlockEditor block={block} onChange={next => { refreshed.value = next; }} />}
        </>;
      }
      const probe = render(<ReadySourceProbe />);
      assert.equal(probe.querySelector('[data-recovered-document-source]')?.textContent, complete.id,
        'the document default shares the ready fingerprint-bound picker');
      assert.equal(probe.querySelector<HTMLSelectElement>('select[aria-label="Answers from"]')?.value, complete.id,
        'bound Refresh also defaults to the completed exact source, not the failed first copy');
      click(button(probe, 'Refresh from current checklist'));
      assert.ok(refreshed.value);
      assert.equal(refreshed.value.reportModels?.[0].name, complete.name);
      assert.equal(refreshed.value.reportModels?.[0].fingerprint, source.sourceFingerprint);
      assert.equal(refreshed.value.groups[0].items[1].status, 'warning');
      assert.equal(JSON.stringify(loadValidationReports()[0]), original);
    });
  }

  it('refuses a saved report without model identity instead of borrowing the active model (#6611)', async () => {
    const { ui } = await saveThenReopenHistory(2);
    const saved = structuredClone(useViewerStore.getState().savedValidationReports[0]);
    if (saved.snapshot.kind !== 'manual-report') assert.fail('real manual Save report produced another kind');
    delete saved.snapshot.modelFingerprint;
    delete saved.snapshot.reportModels;
    act(() => useViewerStore.setState({ savedValidationReports: [saved] }));
    await settle();
    const reuse = button(ui, 'Edit a copy');
    assert.equal(reuse.disabled, true);
    assert.match(ui.textContent ?? '', /recorded model identity/i);
    assert.equal(useViewerStore.getState().manualLibrary.checklists.length, 0);
  });

  it('creates independent copies even when an identical live template already has newer answers (#6611)', async () => {
    const { source, original, ui } = await saveThenReopenHistory(1);
    act(() => {
      useViewerStore.getState().setManualChecklist(checklist);
      useViewerStore.getState().setManualAnswer(source.sourceFingerprint!, 'names', { status: 'fail', comment: 'Newer live review' });
    });
    const existing = structuredClone(useViewerStore.getState().manualLibrary.checklists[0]);
    const history = ui.querySelector<HTMLDetailsElement>('[data-saved-validation-reports]');
    assert.ok(history); act(() => { history.open = true; });
    click(button(ui, 'Edit a copy'));
    assert.notEqual(useViewerStore.getState().manualLibrary.activeId, existing.id);
    assert.equal(row(ui, 'Naming convention').dataset.status, 'warning', 'snapshot answers do not reuse or overwrite the newer live instance');
    assert.deepEqual(useViewerStore.getState().manualLibrary.checklists.find(entry => entry.id === existing.id), existing);
    const firstCopyId = useViewerStore.getState().manualLibrary.activeId;
    click(button(ui, 'Edit a copy'));
    assert.notEqual(useViewerStore.getState().manualLibrary.activeId, firstCopyId);
    assert.equal(useViewerStore.getState().manualLibrary.checklists.length, 3);
    assert.equal(JSON.stringify(loadValidationReports()[0]), original);
  });

  it('requires the recorded source to be loaded before creating an editable copy (#6611)', async () => {
    const { peer, original, ui } = await saveThenReopenHistory(2);
    assert.ok(peer);
    act(() => useViewerStore.setState(fixtureModels(peer)));
    await settle();
    assert.equal(button(ui, 'Edit a copy').disabled, true);
    assert.match(ui.textContent ?? '', /load the recorded model/i);
    assert.equal(useViewerStore.getState().manualLibrary.checklists.length, 0);
    assert.equal(JSON.stringify(loadValidationReports()[0]), original);
  });

  it('retains the restored binding after reload and refuses a peer after its model is removed (#6611)', async () => {
    const { peer, original, ui } = await saveThenReopenHistory(2);
    assert.ok(peer);
    click(button(ui, 'Edit a copy'));
    const library = loadManualLibrary().library;
    cleanup();
    useViewerStore.setState({ ...fixtureModels(peer), manualLibrary: library, ...manualLibraryProjection(library) });
    const reopened = render(<ValidationPanel />);
    assert.match(reopened.textContent ?? '', /load the recorded model/i);
    const check = row(reopened, 'Naming convention');
    assert.equal(button(check, 'Pass').disabled, true, 'missing original source cannot silently become the active peer');
    assert.equal(check.querySelector<HTMLTextAreaElement>('textarea')?.disabled, true);
    assert.equal(JSON.stringify(loadValidationReports()[0]), original);
  });

  it('starts a recovered copy on its recorded source despite a previous live peer pick (#6611)', async () => {
    const { source, peer, ui } = await saveThenReopenHistory(2);
    assert.ok(peer);
    act(() => useViewerStore.getState().setManualChecklist(checklist));
    const picker = ui.querySelector<HTMLSelectElement>('select[aria-label="Model"]');
    assert.ok(picker);
    act(() => { picker.value = peer.id; picker.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(picker.value, peer.id);
    const history = ui.querySelector<HTMLDetailsElement>('[data-saved-validation-reports]');
    assert.ok(history); act(() => { history.open = true; });
    click(button(ui, 'Edit a copy'));
    assert.equal(ui.querySelector<HTMLSelectElement>('select[aria-label="Model"]')?.value, source.id);
    assert.equal(row(ui, 'Naming convention').dataset.status, 'warning', 'the new bound instance cannot inherit a previous live peer pick');
  });

  it('allows an explicit peer review without moving the recorded answers or changing history (#6611)', async () => {
    const { source, peer, original, ui } = await saveThenReopenHistory(2);
    assert.ok(peer);
    click(button(ui, 'Edit a copy'));
    const picker = ui.querySelector<HTMLSelectElement>('select[aria-label="Model"]');
    assert.ok(picker);
    act(() => { picker.value = peer.id; picker.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(row(ui, 'Naming convention').dataset.status, 'unanswered', 'explicit peer starts a separate review');
    click(button(row(ui, 'Naming convention'), 'Fail'));
    assert.equal(useViewerStore.getState().manualAnswers[peer.sourceFingerprint!].names.status, 'fail');
    act(() => { picker.value = source.id; picker.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(row(ui, 'Naming convention').dataset.status, 'warning', 'returning to the recorded model retains its answer');
    assert.equal(row(ui, 'Naming convention').querySelector<HTMLTextAreaElement>('textarea')?.value, 'Recorded prefix needs review');
    assert.equal(JSON.stringify(loadValidationReports()[0]), original);
  });

  it('keeps the document source on the recovered fingerprint and refuses a missing-bound default (#6611)', async () => {
    const { source, peer, ui } = await saveThenReopenHistory(2);
    assert.ok(peer);
    click(button(ui, 'Edit a copy'));
    cleanup();
    function SourceProbe() {
      const sourceHandle = useManualReportSource();
      return <>
        <output data-default-model>{sourceHandle.defaultModelId ?? 'missing'}</output>
        <output data-default-snapshot>{JSON.stringify(sourceHandle.snapshot('document-default'))}</output>
        <output data-explicit-snapshot>{JSON.stringify(sourceHandle.snapshot('document-peer', peer!.id))}</output>
      </>;
    }
    const probe = render(<SourceProbe />);
    assert.equal(probe.querySelector('[data-default-model]')?.textContent, source.id);
    assert.match(probe.querySelector('[data-default-snapshot]')?.textContent ?? '', /Recorded prefix needs review/);
    assert.doesNotMatch(probe.querySelector('[data-explicit-snapshot]')?.textContent ?? '', /Recorded prefix needs review/);
    act(() => useViewerStore.setState(fixtureModels(peer)));
    assert.equal(probe.querySelector('[data-default-model]')?.textContent, 'missing');
    assert.equal(probe.querySelector('[data-default-snapshot]')?.textContent, 'null', 'Add/default snapshot cannot borrow the active peer');
    const explicit = JSON.parse(probe.querySelector('[data-explicit-snapshot]')?.textContent ?? 'null');
    assert.equal(explicit.modelFingerprint, peer.sourceFingerprint, 'an explicit source choice remains available');
    assert.equal(explicit.summary.unanswered, 3);
  });

  it('shows a storage failure while retaining the editable copy and frozen history (#6611)', async () => {
    const { source, original, ui } = await saveThenReopenHistory(1);
    const persistedLibrary = localStorage.getItem('ifc-lite:validation:manual-library');
    const write = mock.method(localStorage, 'setItem', () => { throw new DOMException('Storage full', 'QuotaExceededError'); });
    try {
      click(button(ui, 'Edit a copy'));
      await settle();
      assert.match(ui.querySelector('[role="alert"]')?.textContent ?? '', /storage refused/i);
      assert.equal(row(ui, 'Naming convention').dataset.status, 'warning');
      click(button(row(ui, 'Naming convention'), 'Pass'));
      assert.equal(row(ui, 'Naming convention').dataset.status, 'pass', 'current copy remains editable with a visible persistence warning');
      assert.equal(useViewerStore.getState().manualAnswers[source.sourceFingerprint!].names.status, 'pass');
      assert.equal(localStorage.getItem('ifc-lite:validation:manual-library'), persistedLibrary, 'failed writes do not claim durable success');
      assert.equal(JSON.stringify(loadValidationReports()[0]), original);
    } finally { write.mock.restore(); }
  });
});
