/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { texturedProductSource as source } from '@/test/textured-product-fixture';
import { createAppearancePlanner, type AppearanceWorker } from '../planner-worker-client';
import type { AppearanceWorkerRequest } from '../planner-types';
import type { PdfFillAnnotationPlan, PdfFillAnnotationRequest } from './fill-plan-types';

test('actual decoded PDF fill plans survive host export and reject stale/cancelled worker results (#4406)', async t => {
  const wasm = new URL('../../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
  let binary: Buffer;
  try { binary = await readFile(wasm); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    t.skip('Build WASM with pnpm build:wasm'); return;
  }
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm');
  await init({ module_or_path: binary });
  const api = new IfcAPI();
  try {
    for (const number of [1, 2]) {
      const request = JSON.parse(await readFile(new URL(`../../../../../../docs/architecture/evidence/pdf-fill-annotations/page-${number}-request.json`, import.meta.url), 'utf8')) as PdfFillAnnotationRequest;
      const data = await new IfcParser().parseColumnar(source.slice().buffer);
      const view = new MutablePropertyView(data.properties, 'fill'), editor = new StoreEditor(data, view);
      request.nextExpressId = view.peekNextExpressId();
      const result = JSON.parse(new TextDecoder().decode(api.planPdfFillAnnotation(source, JSON.stringify(request)))) as PdfFillAnnotationPlan;
      assert.equal(result.regions.length, 2);
      assert.deepEqual(result.meshes.map(m => m.color).sort(), [[0, 0, 1, 1], [1, 0, 0, 1]]);
      assert.ok(result.meshes.every(m => m.uvs === undefined && m.texture === undefined));
      for (const row of result.plan.created) assert.equal(editor.addEntity(row.type, row.attributes).expressId, row.expressId);
      const exported = await new StepExporter(data, view).exportAsync({ schema: 'IFC4', applyMutations: true, includeGeometry: true });
      const bytes = typeof exported.content === 'string' ? new TextEncoder().encode(exported.content) : exported.content;
      const reopened = await new IfcParser().parseColumnar(bytes.slice().buffer);
      assert.equal(reopened.entities.getName(result.annotationId), request.Name);
      assert.equal(reopened.entities.getTypeName(result.annotationId), 'IfcAnnotation');
      const { runPdfFillAnnotationPlanning } = await import('../../../workers/appearance.worker.js');
      assert.equal((await runPdfFillAnnotationPlanning(source, request)).requestSha256, result.requestSha256);
      let latest: AppearanceWorkerRequest | undefined, terminations = 0;
      const worker: AppearanceWorker = { onmessage: null, onerror: null, onmessageerror: null,
        postMessage(message) { latest = structuredClone(message); }, terminate() { terminations++; } };
      const planner = createAppearancePlanner({ workerFactory: () => worker });
      try {
        const stale = planner.pdfFillPlan(source, request);
        assert.equal(latest?.type, 'pdf-fill-plan'); assert.ok(latest);
        worker.onmessage?.(new MessageEvent('message', { data: { type: 'pdf-fill-complete', id: latest.id,
          result: { ...result, calibrationKey: 'stale' } } }));
        await assert.rejects(stale, /stale or invalid/);
        const cancelled = planner.pdfFillPlan(source, request);
        planner.cancel(); await assert.rejects(cancelled, /cancelled/); assert.equal(terminations, 2);
        assert.ok(source.byteLength > 0);
      } finally { planner.dispose(); }
    }
  } finally { api.free(); }
});
