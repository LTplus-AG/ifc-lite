/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { beforeEach, afterEach, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '@ifc-lite/ids';
import { parseRuleSetFile } from '@ifc-lite/rules';
import { render, click, cleanup, type as typeInput } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { useIDS } from '@/hooks/useIDS';
import { useInformationValidation } from '@/hooks/validation/useInformationValidation';
import { setValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { activeDefinition, loadDefinitionLibrary, type DefinitionKind } from '@/lib/validation/definition-library';
import { ValidationPanel } from './ValidationPanel.js';

const initial = useViewerStore.getState();
const xml = readFileSync(new URL('../../../../public/samples/building-architecture.ids', import.meta.url), 'utf8');
const parsedIds = parseIDS(xml);
const ruleSource = { version: 1, name: 'Independent check', rules: [{
  id: 'wall-name', name: 'Wall name',
  applicability: { groups: [{ rules: [{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }], combinator: 'AND' }], authoredAs: 'chips' },
  requirement: { kind: 'element', block: { groups: [{ rules: [{ kind: 'attribute', name: 'Name', op: 'isSet', value: '' }], combinator: 'AND' }], authoredAs: 'chips' } },
}] };
const parsedRules = parseRuleSetFile(ruleSource);
assert.ok(parsedRules.ok);
let owner: { ids: ReturnType<typeof useIDS>; info: ReturnType<typeof useInformationValidation> };
function Owner() {
  owner = { ids: useIDS({ autoApplyColors: false }), info: useInformationValidation() };
  return null;
}
beforeEach(() => { localStorage.clear(); useViewerStore.setState(initial); setValidationSourceChoice(null); });
afterEach(() => { cleanup(); useViewerStore.setState(initial); setValidationSourceChoice(null); });

async function models(count: number): Promise<void> {
  const loaded = [];
  for (let index = 0; index < count; index++) {
    const name = index ? 'building-architecture-rev-b.ifc' : 'building-architecture.ifc';
    const bytes = readFileSync(new URL('../../../../public/samples/' + name, import.meta.url));
    const data = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer);
    assert.ok(data.entityCount > 400);
    loaded.push({ ...fixtureModel(`model-${index}`), name, ifcDataStore: data });
  }
  useViewerStore.setState(fixtureModels(...loaded));
}

for (const count of [1, 2]) for (const kind of ['rules', 'ids'] as const) {
  it(`#6567 selecting a copied ${kind} check cancels an actual pending validation across mounted callers at ${count} model(s)`, async () => {
    await models(count);
    setValidationSourceChoice(kind);
    const ui = render(<><Owner /><ValidationPanel /></>);
    await importFile(ui, kind, kind === 'ids' ? xml : JSON.stringify(ruleSource));
    await waitFor(() => !useViewerStore.getState().idsAuditing);
    await act(async () => { await (kind === 'ids' ? owner.ids.runValidation() : owner.info.run()); });
    const completed = useViewerStore.getState().idsValidationReport;
    assert.ok(completed && completed.specificationResults.length > 0, 'the actual validator first completed a check of real IFC input');
    click(button(ui, 'Save report'));
    const saved = JSON.stringify(useViewerStore.getState().savedValidationReports);
    const original = activeDefinition(useViewerStore.getState().validationDefinitions, kind);
    assert.ok(original);
    let running!: Promise<unknown>;
    let settled = false;
    let copiedId: string | undefined;
    const landed: string[] = [];
    const unsubscribe = useViewerStore.subscribe(state => {
      if (copiedId && state.idsValidationReport) landed.push(state.idsValidationReport.source.kind);
    });
    try {
      act(() => {
        running = kind === 'ids' ? owner.ids.runValidation() : owner.info.run();
        void running.finally(() => { settled = true; });
        assert.equal(settled, false, 'the real engine promise is pending when the other mounted caller changes the source');
        click(button(ui, 'New from this check'));
        copiedId = activeDefinition(useViewerStore.getState().validationDefinitions, kind)?.id;
      });
      assert.ok(copiedId && copiedId !== original.id);
      await act(async () => { await running; });
      assert.deepEqual(landed, [], 'the old engine cannot publish under the copied check');
      assert.equal(useViewerStore.getState().idsValidationReport, null);
      assert.equal(useViewerStore.getState().idsProgress, null);
      assert.equal(useViewerStore.getState().idsLoading, false);
      assert.equal(owner.info.running, false);
      assert.equal(activeDefinition(useViewerStore.getState().validationDefinitions, kind)?.id, copiedId);
      assert.equal(JSON.stringify(useViewerStore.getState().savedValidationReports), saved);
    } finally { unsubscribe(); }
  });
}
function button(ui: HTMLElement, text: string): HTMLButtonElement {
  const target = [...ui.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent?.trim() === text);
  assert.ok(target, `mounted control ${text} exists`);
  return target;
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    assert.ok(Date.now() - start < 8000, 'canonical validation/import settles');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}
async function importFile(ui: HTMLElement, kind: DefinitionKind, text: string): Promise<void> {
  const accept = kind === 'ids' ? '.ids,.xml' : '.rules.json,.json';
  const input = ui.querySelector<HTMLInputElement>(`input[accept="${accept}"]`);
  assert.ok(input);
  Object.defineProperty(input, 'files', { configurable: true, value: [new File([text], kind === 'ids' ? 'check.ids' : 'check.rules.json')] });
  const count = useViewerStore.getState().validationDefinitions.entries.length;
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await waitFor(() => useViewerStore.getState().validationDefinitions.entries.length === count + 1);
}
async function select(ui: HTMLElement, kind: DefinitionKind, id: string): Promise<void> {
  const label = kind === 'ids' ? 'Select IDS document' : 'Select rule set';
  const picker = ui.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  assert.ok(picker);
  await act(async () => { picker.value = id; picker.dispatchEvent(new Event('change', { bubbles: true })); });
}

for (const count of [1, 2]) for (const kind of ['rules', 'ids'] as const) {
  it(`#6567 ${kind} copy/edit/delete and same-title import preserve source identity and saved real report at ${count} model(s)`, async () => {
    await models(count);
    setValidationSourceChoice(kind);
    const ui = render(<ValidationPanel />);
    const source = kind === 'ids' ? xml : JSON.stringify(ruleSource);
    await importFile(ui, kind, source);
    const original = activeDefinition(useViewerStore.getState().validationDefinitions, kind);
    assert.ok(original);
    const originalBytes = JSON.stringify(original);
    click(button(ui, kind === 'rules' ? 'Run' : 'Run Validation'));
    await waitFor(() => useViewerStore.getState().idsValidationReport !== null && !useViewerStore.getState().idsLoading);
    const report = useViewerStore.getState().idsValidationReport;
    assert.ok(report);
    assert.equal(report.source.kind, kind);
    assert.ok(report.specificationResults.length > 0, 'the real evaluator checked the actual IFC input');
    click(button(ui, 'Save report'));
    assert.equal(useViewerStore.getState().savedValidationReports.length, 1);
    const saved = JSON.stringify(useViewerStore.getState().savedValidationReports);

    click(button(ui, 'New from this check'));
    const copied = activeDefinition(useViewerStore.getState().validationDefinitions, kind);
    assert.ok(copied);
    assert.notEqual(copied.id, original.id);
    assert.equal(useViewerStore.getState().idsValidationReport, null, 'switching definitions releases the previous current report');
    if (copied.kind === 'rules') {
      const name = ui.querySelector<HTMLInputElement>('input[aria-label="Rule set name"]');
      assert.ok(name);
      typeInput(name, 'Edited copied check');
      assert.equal(activeDefinition(useViewerStore.getState().validationDefinitions, 'rules')?.kind, 'rules');
    } else {
      assert.equal(copied.xml, xml);
      assert.deepEqual(copied.document.specifications, parsedIds.specifications);
    }
    assert.equal(JSON.stringify(useViewerStore.getState().validationDefinitions.entries.find(entry => entry.id === original.id)), originalBytes);
    click(button(ui, 'Delete check'));
    assert.equal(activeDefinition(useViewerStore.getState().validationDefinitions, kind)?.id, original.id);
    assert.equal(useViewerStore.getState().validationDefinitions.entries.some(entry => entry.id === copied.id), false);
    await importFile(ui, kind, source);
    assert.notEqual(activeDefinition(useViewerStore.getState().validationDefinitions, kind)?.id, original.id, 'same-title import is a new independent check');
    await select(ui, kind, original.id);
    const restored = activeDefinition(useViewerStore.getState().validationDefinitions, kind);
    assert.ok(restored);
    if (restored.kind === 'ids') assert.equal(restored.xml, xml);
    else assert.deepEqual(restored.file, parsedRules.file);
    assert.equal(JSON.stringify(useViewerStore.getState().savedValidationReports), saved, 'copy, selection and deletion leave saved evidence unchanged');
    const persisted = loadDefinitionLibrary();
    assert.equal(persisted.error, null);
    assert.equal(persisted.library.active[kind], original.id);
    assert.equal(persisted.library.entries.length, 2, 'both same-title sources are available after a real persistence round trip');
  });
}
