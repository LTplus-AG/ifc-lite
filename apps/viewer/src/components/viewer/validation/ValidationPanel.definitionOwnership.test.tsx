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
import { render, cleanup } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { useIDS } from '@/hooks/useIDS';
import { useInformationValidation } from '@/hooks/validation/useInformationValidation';
import { setValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { activeDefinition, type DefinitionKind } from '@/lib/validation/definition-library';
import { ValidationPanel } from './ValidationPanel.js';

const initial = useViewerStore.getState();
const originalReader = globalThis.FileReader;
const xml = readFileSync(new URL('../../../../public/samples/building-architecture.ids', import.meta.url), 'utf8');
const originalTitle = parseIDS(xml).info.title;
const source = (kind: DefinitionKind, title: string) => kind === 'ids' ? xml.replace(originalTitle, title) : JSON.stringify({ version: 1, name: title, rules: [] });
interface Gate { reached: boolean; opened: Promise<void>; release: () => void }
const gates: Gate[] = [];
const pending: Promise<unknown>[] = [];
const owners: Array<{ ids: ReturnType<typeof useIDS>; info: ReturnType<typeof useInformationValidation> }> = [];
function gate(): Gate {
  let release!: () => void;
  const result = { reached: false, opened: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
  gates.push(result);
  return result;
}

/** Hold a real decoded File.text result, never substitute parser input. */
class WaitingFile extends File {
  constructor(parts: BlobPart[], name: string, readonly barrier: Gate) { super(parts, name); }
  override async text(): Promise<string> {
    const content = await super.text();
    this.barrier.reached = true;
    await this.barrier.opened;
    return content;
  }
}
/** Information import uses the actual FileReader. Hold its real load
 * callback only after the reader has populated result with the file bytes. */
class WaitingReader extends originalReader {
  override readAsText(blob: Blob, encoding?: string): void {
    if (blob instanceof WaitingFile) {
      const callback = this.onload;
      this.onload = event => {
        blob.barrier.reached = true;
        void blob.barrier.opened.then(() => callback?.call(this, event));
      };
    }
    super.readAsText(blob, encoding);
  }
}
function Owner({ index }: { index: number }) {
  const ids = useIDS({ autoApplyColors: false });
  const info = useInformationValidation();
  owners[index] = { ids, info };
  return null;
}
function mount(): HTMLElement { return render(<><Owner index={0} /><Owner index={1} /><ValidationPanel /></>); }
function load(index: number, kind: DefinitionKind, file: File): Promise<unknown> {
  const promise = kind === 'ids' ? owners[index].ids.loadIDSFile(file) : owners[index].info.openFromFile(file);
  pending.push(promise);
  return promise;
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    assert.ok(Date.now() - started < 5000, 'real file decoding and projection complete');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}
async function models(count: number, prefix: string): Promise<void> {
  const loaded = [];
  for (let index = 0; index < count; index++) {
    const name = index ? 'building-architecture-rev-b.ifc' : 'building-architecture.ifc';
    const bytes = readFileSync(new URL('../../../../public/samples/' + name, import.meta.url));
    const store = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer);
    assert.ok(store.entityCount > 400);
    loaded.push({ ...fixtureModel(`${prefix}-${index}`), name, ifcDataStore: store });
  }
  useViewerStore.setState(fixtureModels(...loaded));
}
function title(kind: DefinitionKind): string | undefined {
  const entry = activeDefinition(useViewerStore.getState().validationDefinitions, kind);
  return entry?.kind === 'ids' ? entry.document.info.title : entry?.file.name;
}
beforeEach(() => {
  localStorage.clear(); useViewerStore.setState(initial); setValidationSourceChoice(null);
  gates.length = 0; pending.length = 0; owners.length = 0;
  globalThis.FileReader = WaitingReader;
});
afterEach(async () => {
  for (const barrier of gates) barrier.release();
  await Promise.allSettled(pending);
  cleanup(); globalThis.FileReader = originalReader;
  useViewerStore.setState(initial); setValidationSourceChoice(null);
});

for (const count of [1, 2]) for (const kind of ['rules', 'ids'] as const) {
  it(`#6567 keeps the active ${kind} source usable in a mounted panel across canonical full-model reset and new ${count}-model inputs`, async () => {
    await models(count, 'before');
    setValidationSourceChoice(kind);
    const ui = mount();
    await act(async () => { await load(0, kind, new File([source(kind, 'Retained check')], 'retained')); });
    const before = activeDefinition(useViewerStore.getState().validationDefinitions, kind);
    assert.ok(before);
    const bytes = JSON.stringify(before);
    await act(async () => { useViewerStore.getState().clearAllModels(); });
    assert.equal(useViewerStore.getState().models.size, 0, 'the actual canonical reset cleared model inputs');
    await act(async () => { await models(count, 'after'); });
    const current = activeDefinition(useViewerStore.getState().validationDefinitions, kind);
    assert.ok(current);
    assert.equal(JSON.stringify(current), bytes, 'reset does not recreate or mutate the persisted definition');
    const state = useViewerStore.getState();
    if (kind === 'ids') {
      assert.equal(state.idsDocument?.info.title, 'Retained check', 'active selector and canonical IDS projection agree without remount');
      assert.deepEqual(state.idsDocument?.specifications, before.kind === 'ids' ? before.document.specifications : null);
    } else assert.equal(state.validationRuleSetDraft?.name, 'Retained check', 'active selector and editable canonical rules projection agree without remount');
    assert.ok(ui.textContent?.includes('Retained check'));
  });
}

for (const kind of ['rules', 'ids'] as const) for (const crossHook of [false, true]) for (const firstToFinish of ['older', 'newer'] as const) {
  it(`#6567 ${kind} latest file pick owns completion with ${crossHook ? 'two mounted hook callers' : 'one hook caller'} when ${firstToFinish} real decode finishes first`, async () => {
    await models(1, 'source');
    setValidationSourceChoice(kind);
    mount();
    const olderGate = gate(), newerGate = gate();
    let older!: Promise<unknown>, newer!: Promise<unknown>;
    act(() => { older = load(0, kind, new WaitingFile([source(kind, 'Older pick')], 'older', olderGate)); });
    await waitFor(() => olderGate.reached);
    act(() => { newer = load(crossHook ? 1 : 0, kind, new WaitingFile([source(kind, 'Newer pick')], 'newer', newerGate)); });
    await waitFor(() => newerGate.reached);
    if (firstToFinish === 'older') {
      await act(async () => { olderGate.release(); await older; });
      assert.equal(title(kind), undefined, 'an obsolete decoded file cannot become the active source while the newer pick is held');
      if (kind === 'ids') assert.equal(useViewerStore.getState().idsLoading, true, 'obsolete finally cannot reset newer file loading');
      await act(async () => { newerGate.release(); await newer; });
    } else {
      await act(async () => { newerGate.release(); await newer; });
      assert.equal(title(kind), 'Newer pick');
      await act(async () => { olderGate.release(); await older; });
    }
    assert.equal(title(kind), 'Newer pick');
    assert.equal(useViewerStore.getState().validationDefinitions.entries.length, 1, 'cancelled older imports never replace or add a check');
    if (kind === 'ids') assert.equal(useViewerStore.getState().idsDocument?.info.title, 'Newer pick');
    else assert.equal(useViewerStore.getState().validationRuleSetDraft?.name, 'Newer pick');
  });
}
