/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '@ifc-lite/ids';
import { parseRuleSetFile } from '@ifc-lite/rules';
import { cleanup, render, type as typeInput } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { setValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { ValidationPanel } from './ValidationPanel.js';

const initial = useViewerStore.getState();
const rules = JSON.stringify({ version: 1, name: 'Delivery rules', rules: [{
  id: 'wall-name', name: 'Wall name is recorded',
  applicability: { groups: [{ rules: [{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }], combinator: 'AND' }], authoredAs: 'chips' },
  requirement: { kind: 'element', block: { groups: [{ rules: [{ kind: 'attribute', name: 'Name', op: 'isSet', value: '' }], combinator: 'AND' }], authoredAs: 'chips' } },
}] });
const ids = readFileSync(new URL('../../../../public/samples/building-architecture.ids', import.meta.url), 'utf8');

beforeEach(() => {
  localStorage.clear();
  useViewerStore.setState({ ...initial, models: new Map(), idsDocument: null, idsAuditReport: null,
    idsValidationReport: null, currentValidationReport: null, validationSource: null,
    idsLoading: false, idsAuditing: false, idsError: null, savedValidationReports: [] });
  useViewerStore.getState().clearValidationRuleSetDraft();
  setValidationSourceChoice(null);
});
afterEach(() => { cleanup(); useViewerStore.setState(initial); setValidationSourceChoice(null); });

async function publicModels(count: number): Promise<void> {
  const models = [];
  for (let index = 0; index < count; index++) {
    const name = index ? 'building-architecture-rev-b.ifc' : 'building-architecture.ifc';
    const bytes = readFileSync(new URL('../../../../public/samples/' + name, import.meta.url));
    const store = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer);
    assert.ok(store.entityCount > 400, 'canonical parser decodes the actual public IFC');
    models.push({ ...fixtureModel(`source-${index}`), name, ifcDataStore: store });
  }
  useViewerStore.setState(fixtureModels(...models));
}

async function pick(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function waitFor(ready: () => boolean): Promise<void> {
  const started = Date.now();
  while (!ready()) {
    assert.ok(Date.now() - started < 5000, 'actual import reaches its canonical active projection');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}
function select(ui: HTMLElement, label: string): HTMLSelectElement {
  const picker = ui.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  assert.ok(picker, `#6567 imported definitions remain selectable through ${label}`);
  return picker;
}
async function choose(picker: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => { picker.value = value; picker.dispatchEvent(new Event('change', { bubbles: true })); });
}

for (const count of [1, 2]) {
  it(`#6567 imports two information checks without losing the first edited definition at ${count} model(s)`, async () => {
    await publicModels(count);
    assert.equal(parseRuleSetFile(JSON.parse(rules)).ok, true, 'authored rule fixture meets the real package contract');
    setValidationSourceChoice('rules');
    const ui = render(<ValidationPanel />);
    const input = ui.querySelector<HTMLInputElement>('input[type="file"][accept=".rules.json,.json"]');
    assert.ok(input);
    await pick(input, new File([rules], 'delivery.rules.json', { type: 'application/json' }));
    await waitFor(() => ui.querySelector('input[aria-label="Rule set name"]') !== null);
    const name = ui.querySelector<HTMLInputElement>('input[aria-label="Rule set name"]');
    assert.ok(name);
    typeInput(name, 'Edited delivery rules');
    const picker = select(ui, 'Select rule set');
    const firstId = picker.value;
    assert.ok(firstId);
    const nextInput = ui.querySelector<HTMLInputElement>('input[type="file"][accept=".rules.json,.json"]');
    assert.ok(nextInput, 'import stays available alongside the active definition');
    await pick(nextInput, new File([rules.replace('Delivery rules', 'Peer rules')], 'peer.rules.json', { type: 'application/json' }));
    await waitFor(() => select(ui, 'Select rule set').options.length >= 2);
    assert.notEqual(select(ui, 'Select rule set').value, firstId, 'the second import has independent definition identity');
    await choose(select(ui, 'Select rule set'), firstId);
    assert.equal(ui.querySelector<HTMLInputElement>('input[aria-label="Rule set name"]')?.value, 'Edited delivery rules');
    assert.equal(useViewerStore.getState().validationRuleSetDraft?.rules[0].name, 'Wall name is recorded');
  });

  it(`#6567 imports two IDS checks and switches back to exact specifications at ${count} model(s)`, async () => {
    await publicModels(count);
    const parsed = parseIDS(ids);
    assert.ok(parsed.specifications.length > 0, 'committed IDS document has real parsed specifications');
    setValidationSourceChoice('ids');
    const ui = render(<ValidationPanel />);
    const input = ui.querySelector<HTMLInputElement>('input[type="file"][accept=".ids,.xml"]');
    assert.ok(input);
    await pick(input, new File([ids], 'building-architecture.ids', { type: 'application/xml' }));
    await waitFor(() => useViewerStore.getState().idsDocument?.info.title === parsed.info.title);
    const picker = select(ui, 'Select IDS document');
    const firstId = picker.value;
    assert.ok(firstId);
    const secondXml = ids.replace(parsed.info.title, 'Independent IDS check');
    assert.equal(parseIDS(secondXml).info.title, 'Independent IDS check');
    const nextInput = ui.querySelector<HTMLInputElement>('input[type="file"][accept=".ids,.xml"]');
    assert.ok(nextInput);
    await pick(nextInput, new File([secondXml], 'independent.ids', { type: 'application/xml' }));
    await waitFor(() => select(ui, 'Select IDS document').options.length >= 2);
    assert.notEqual(select(ui, 'Select IDS document').value, firstId);
    await choose(select(ui, 'Select IDS document'), firstId);
    await waitFor(() => useViewerStore.getState().idsDocument?.info.title === parsed.info.title);
    assert.deepEqual(useViewerStore.getState().idsDocument?.specifications, parsed.specifications,
      'canonical parser restores every facet, identifier and constraint of the first source');
    assert.ok(ui.textContent?.includes(parsed.info.title), 'mounted IDS panel shows the selected definition');
  });
}
