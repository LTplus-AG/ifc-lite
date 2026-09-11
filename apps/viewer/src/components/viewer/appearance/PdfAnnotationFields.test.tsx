/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, useState } from 'react';
import { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { pdfReferenceAnnotationFixture } from '@/test/pdf-reference-annotation-fixture';
import { render, cleanup, click } from '@/test/render';
import type { AppearanceWorkerRequest, AppearanceWorkerResponse } from '@/lib/appearance/planner-types';
import type { PdfFillAnnotationPlan } from '@/lib/appearance/pdf/fill-plan-types';
import { PdfAnnotationFields } from './PdfAnnotationFields';

async function until(predicate: () => boolean) {
  for (let tries = 0; tries < 100 && !predicate(); tries++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  assert.ok(predicate(), 'bounded mounted interaction completed');
}
test('PDF preview cancellation, changed inputs and stale models cannot enable late native results (#4406)', async t => {
  let binary: Buffer;
  try { binary = await readFile(new URL('../../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; t.skip('Build WASM with pnpm build:wasm'); return; }
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm'); await init({ module_or_path: binary });
  const api = new IfcAPI(), fixture = await pdfReferenceAnnotationFixture();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  let pending: (() => void) | undefined, terminations = 0;
  class ControlledWorker {
    onmessage: ((event: MessageEvent<AppearanceWorkerResponse>) => void) | null = null;
    onerror = null; onmessageerror = null;
    terminate() { terminations++; }
    postMessage(message: AppearanceWorkerRequest) {
      if (message.type !== 'pdf-fill-plan') throw new Error('Unexpected planner job');
      const handler = this.onmessage;
      pending = () => {
        const result = JSON.parse(new TextDecoder().decode(api.planPdfFillAnnotation(message.source, JSON.stringify(message.request)))) as PdfFillAnnotationPlan;
        handler?.(new MessageEvent('message', { data: { type: 'pdf-fill-complete', id: message.id, result } }));
      };
    }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: ControlledWorker });
  mock.method(Renderer.prototype, 'init', async () => {});
  mock.method(Renderer.prototype, 'loadGeometry', () => {});
  mock.method(Renderer.prototype, 'fitToView', () => {});
  mock.method(Renderer.prototype, 'render', () => {});
  function Panel() {
    const [Name, setName] = useState('First annotation');
    return <><button onClick={() => setName('Changed annotation')}>Change annotation name</button>
      <PdfAnnotationFields referenceId={fixture.reference.id} modelId="pdf-target" containerId={40} Name={Name} disabled={false} /></>;
  }
  try {
    const ui = render(<Panel />);
    const button = (name: string) => [...ui.querySelectorAll('button')].find(item => item.textContent === name);
    const start = async () => { pending = undefined; click(button('Prepare vector preview')!); await until(() => !!pending); };
    await start(); const lateCancel = pending!;
    click(button('Cancel')!); await act(async () => { lateCancel(); });
    assert.ok(terminations > 0); assert.equal(button('Create annotation'), undefined);
    assert.match(ui.textContent ?? '', /cancelled/);
    await start(); const lateInput = pending!;
    click(button('Change annotation name')!); await act(async () => { lateInput(); });
    assert.equal(button('Create annotation'), undefined, 'changed visible Name cannot reuse the previous planned IFC metadata');
    await start(); await act(async () => { pending!(); });
    await until(() => !!button('Create annotation') && !button('Create annotation')!.disabled);
    assert.equal(fixture.view.getNewEntities().length, 0, 'ready preview still has no authored IFC rows');
    act(() => useViewerStore.setState({ models: new Map() }));
    await until(() => button('Create annotation') === undefined);
    assert.match(ui.textContent ?? '', /target model changed/);
    assert.equal(fixture.view.getNewEntities().length, 0);
  } finally {
    cleanup(); mock.restoreAll(); fixture.dispose(); api.free();
    if (descriptor) Object.defineProperty(globalThis, 'Worker', descriptor); else Reflect.deleteProperty(globalThis, 'Worker');
  }
});
