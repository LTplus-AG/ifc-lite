/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { render, cleanup, click, type as typeInto, advance } from '@/test/render.js';
import { newFlowDocument } from '@/lib/flow/persistence';
import { DOCUMENT_VERSION } from '@/lib/document/types';
import type { FlowDocument } from '@ifc-lite/flow';
import { FlowAutomationEditor } from './FlowAutomationEditor';

afterEach(cleanup);
let edited: FlowDocument;
function mount(doc: FlowDocument): HTMLElement {
  edited = doc;
  function Harness() { const [value, setValue] = useState(doc); return <FlowAutomationEditor doc={value} onChange={(next) => { edited = next; setValue(next); }} />; }
  return render(<Harness />);
}
function button(ui: HTMLElement, text: string): HTMLButtonElement {
  const result = [...ui.querySelectorAll('button')].find((value) => value.textContent === text); assert.ok(result); return result;
}
function input(ui: HTMLElement, label: string): HTMLInputElement {
  const result = [...ui.querySelectorAll('input')].find((value) => value.getAttribute('aria-label') === label); assert.ok(result); return result;
}
async function upload(ui: HTMLElement, label: string, contents: unknown): Promise<void> {
  const target = input(ui, label);
  Object.defineProperty(target, 'files', { configurable: true, value: [new File([JSON.stringify(contents)], 'config.json')] });
  await act(async () => { target.dispatchEvent(new Event('change', { bubbles: true })); });
  await advance(20);
}
function select(ui: HTMLElement, label: string, value: string): void {
  const target = [...ui.querySelectorAll('select')].find((el) => el.getAttribute('aria-label') === label); assert.ok(target);
  act(() => { target.value = value; target.dispatchEvent(new Event('change', { bubbles: true })); });
}

describe('workflow configuration forms (#6612)', () => {
  it('edits filename rules through real controls, including temporarily blank patterns', () => {
    const ui = mount({ ...newFlowDocument('Checks'), nodes: [{ id: 'tags', type: 'session.assignModelTags' }] });
    click(button(ui, 'Add filename rule'));
    typeInto(input(ui, 'Filename pattern'), '');
    typeInto(input(ui, 'Filename pattern'), '*-ARC.ifc');
    typeInto(input(ui, 'Tag names, separated by commas'), 'Architecture, Coordination');
    assert.deepEqual(edited.nodes[0].params?.rules, [{ operator: 'glob', pattern: '*-ARC.ifc', tags: ['Architecture', 'Coordination'] }]);
  });
  it('uses qualified file slots for external jobs and retains ordered disabled jobs', () => {
    const doc = { ...newFlowDocument('Checks'), nodes: [{ id: 'checks', type: 'validation.runChecks' }],
      inputs: [{ nodeId: 'checks', param: 'files', label: 'Definitions', kind: 'files' as const,
        fileSlots: [{ id: 'definitions', label: 'Definitions', accept: '.json,.ids', required: true, multiple: true }] }] };
    const ui = mount(doc);
    click(button(ui, 'Add check job'));
    typeInto(input(ui, 'Stable job ID'), 'ids-job');
    select(ui, 'Configuration storage', 'slot');
    select(ui, 'Configuration file slot', 'checks.files/definitions');
    const enabled = ui.querySelector('input[type="checkbox"]'); assert.ok(enabled); click(enabled);
    const jobs = edited.nodes[0].params?.jobs as { id: string; enabled: boolean; source: unknown }[];
    assert.deepEqual(jobs.map(({ id, enabled, source }) => ({ id, enabled, source })), [{ id: 'ids-job', enabled: false,
      source: { kind: 'slot', slotId: 'checks.files/definitions' } }]);
  });
  it('rejects historical evidence and imports explicit rerunnable comparison setup', async () => {
    const ui = mount({ ...newFlowDocument('Checks'), nodes: [{ id: 'checks', type: 'comparison.runChecks' }] });
    click(button(ui, 'Add check job'));
    await upload(ui, 'Import configuration file', { rows: [], generatedAt: '2026-01-01' });
    assert.match(ui.textContent ?? '', /not a completed report/);
    await upload(ui, 'Import configuration file', { kind: 'ifc-lite-comparison-recipe', version: 1, id: 'compare', name: 'Review',
      base: { kind: 'filename', filename: 'a.ifc' }, head: { kind: 'filename', filename: 'b.ifc' },
      options: { scope: 'data', excludedTypes: [], matchByContent: false } });
    typeInto(input(ui, 'A/base model selector'), 'before.ifc');
    const jobs = edited.nodes[0].params?.jobs as { source: { kind: string; value: { base: unknown } } }[];
    assert.deepEqual(jobs[0].source.value.base, { kind: 'filename', filename: 'before.ifc' });
  });
  it('imports a native template and maps report blocks to explicit jobs/results', async () => {
    const ui = mount({ ...newFlowDocument('Checks'), nodes: [
      { id: 'checks', type: 'validation.runChecks', params: { jobs: [{ id: 'ids-job', enabled: true, source: { kind: 'embedded', value: '<ids />' } }] } },
      { id: 'document', type: 'report.buildDocument' },
    ] });
    await upload(ui, 'Import document template', { version: DOCUMENT_VERSION, id: 'template', name: 'Report', page: { size: 'A4', orientation: 'portrait' },
      blocks: [{ id: 'report', kind: 'ids-report', sourceKind: 'ids', sourceName: 'Old', generatedAt: '2026-01-01T00:00:00Z',
        summary: { checked: 1, passed: 1, failed: 0, passRate: 100 }, checks: [] }] });
    const imported = edited.nodes[1].params?.config as { template: { blocks: { id: string }[] }; mappings: unknown };
    const blockId = imported.template.blocks[0].id;
    select(ui, `Job for block ${blockId}`, 'ids-job');
    typeInto(input(ui, `Optional result ID for block ${blockId}`), 'model-a');
    const config = edited.nodes[1].params?.config as { mappings: unknown };
    assert.deepEqual(config.mappings, [{ blockId, jobId: 'ids-job', resultId: 'model-a' }]);
  });
  it('drops a pending template import when switching graphs with the same report node ID (#6612)', async () => {
    const first = { ...newFlowDocument('First'), nodes: [{ id: 'document', type: 'report.buildDocument' }] };
    const second = { ...newFlowDocument('Second'), nodes: [{ id: 'document', type: 'report.buildDocument' }] };
    let switchGraph: () => void = () => assert.fail('Harness has not mounted');
    const changes: FlowDocument[] = [];
    function Harness() {
      const [doc, setDoc] = useState<FlowDocument>(first);
      switchGraph = () => setDoc(second);
      return <FlowAutomationEditor doc={doc} onChange={(next) => { changes.push(next); setDoc(next); }} />;
    }
    const ui = render(<Harness />);
    let finishRead: (text: string) => void = () => assert.fail('File read has not started');
    const file = new File([], 'delayed-template.json');
    Object.defineProperty(file, 'text', { value: () => new Promise<string>((resolve) => { finishRead = resolve; }) });
    const target = input(ui, 'Import document template');
    Object.defineProperty(target, 'files', { configurable: true, value: [file] });
    act(() => { target.dispatchEvent(new Event('change', { bubbles: true })); });
    act(() => switchGraph());
    await act(async () => finishRead(JSON.stringify({ version: DOCUMENT_VERSION, id: 'late', name: 'Late template',
      page: { size: 'A4', orientation: 'portrait' }, blocks: [{ kind: 'text', id: 'late-text', text: 'Old graph template', style: 'body' }] })));
    assert.deepEqual(changes, [], 'the old asynchronous upload never edits the newly opened graph');
    assert.equal(ui.textContent?.includes('Late template'), false);
  });

  it('drops a pending resource import across graph copies sharing the same job source (#6612)', async () => {
    const jobs = [{ id: 'check', enabled: true, source: { kind: 'embedded', value: null } }];
    const first = { ...newFlowDocument('First'), nodes: [{ id: 'checks', type: 'comparison.runChecks', params: { jobs } }] };
    const second = { ...first, id: crypto.randomUUID(), name: 'Second' };
    let switchGraph: () => void = () => assert.fail('Harness has not mounted');
    const changes: FlowDocument[] = [];
    function Harness() {
      const [doc, setDoc] = useState<FlowDocument>(first);
      switchGraph = () => setDoc(second);
      return <FlowAutomationEditor doc={doc} onChange={(next) => { changes.push(next); setDoc(next); }} />;
    }
    const ui = render(<Harness />);
    let finishRead: (text: string) => void = () => assert.fail('File read has not started');
    const file = new File([], 'delayed-rules.json');
    Object.defineProperty(file, 'text', { value: () => new Promise<string>((resolve) => { finishRead = resolve; }) });
    const target = input(ui, 'Import configuration file');
    Object.defineProperty(target, 'files', { configurable: true, value: [file] });
    act(() => { target.dispatchEvent(new Event('change', { bubbles: true })); });
    act(() => switchGraph());
    await act(async () => finishRead(JSON.stringify({ kind: 'ifc-lite-comparison-recipe', version: 1, id: 'late', name: 'Late resource',
      base: { kind: 'filename', filename: 'a.ifc' }, head: { kind: 'filename', filename: 'b.ifc' },
      options: { scope: 'data', excludedTypes: [], matchByContent: false } })));
    assert.deepEqual(changes, [], 'matching shared source objects cannot authorize an import into another graph');
    assert.equal(second.nodes[0].params.jobs[0].source.value, null);
  });

});
