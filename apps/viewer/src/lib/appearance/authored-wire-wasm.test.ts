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
import type { AnnotationPlanePlan, CapturedMeshPlan } from './planner-types';
import { texturedProductSource as source } from '@/test/textured-product-fixture';

test('native creators refuse wire tokens and preserve ordinary Names through StoreEditor STEP export (#4441)', async t => {
  let wasm: Buffer;
  try { wasm = await readFile(new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    t.skip('Build WASM with pnpm build:wasm'); return;
  }
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm');
  await init({ module_or_path: wasm });
  const api = new IfcAPI();
  try {
    for (const captured of [false, true]) {
      const common = { schema: 'IFC4', sourceRevision: 'wire-test', containerId: 40,
        GlobalId: '0aaaaaaaaaaaaaaaaaaaaa', containmentGlobalId: '0bbbbbbbbbbbbbbbbbbbbb',
        imageUri: 'textures/image.png',
        ...(captured ? { mesh: { positions: [[0,0,0],[1,0,0],[0,1,0]], triangles: [[0,1,2]],
          uvs: [[0,0],[1,0],[0,1]], uvTriangles: [[0,1,2]] } }
          : { frame: { origin: [2,3,4], axisU: [1,0,0], axisV: [0,0,1], sizeMetres: [2,1] } }) };
      const plan = (input: object) => JSON.parse(new TextDecoder().decode(captured
        ? api.planCapturedMesh(source, JSON.stringify(input))
        : api.planAnnotationPlane(source, JSON.stringify(input)))) as AnnotationPlanePlan | CapturedMeshPlan;
      for (const Name of ['*', '$', '#123', '.ENUM.', ' .lower_1. ', '\ufeff#123\ufeff']) {
        assert.throws(() => plan({ ...common, nextExpressId: 100, Name }), /Authored product Name is a reserved appearance wire token/);
      }
      for (const imageUri of ['*', '$', '.ENUM.', ' .lower_1. ']) {
        assert.throws(() => plan({ ...common, nextExpressId: 100, Name: 'Ordinary', imageUri }), /Image URI is a reserved appearance wire token/);
      }
      for (const Name of ['Ordinary name', "O'Brien – 墙", '#not_a_ref', '.not-an-enum.', '* label', '\u0085#123\u0085']) {
        const data = await new IfcParser().parseColumnar(source.slice().buffer);
        const view = new MutablePropertyView(data.properties, 'wire-test');
        const editor = new StoreEditor(data, view);
        const result = plan({ ...common, nextExpressId: view.peekNextExpressId(), Name });
        for (const row of result.plan.created) assert.equal(editor.addEntity(row.type, row.attributes).expressId, row.expressId);
        const exported = await new StepExporter(data, view).exportAsync({ schema: 'IFC4', applyMutations: true, includeGeometry: true });
        const bytes = typeof exported.content === 'string' ? new TextEncoder().encode(exported.content) : exported.content;
        const reopened = await new IfcParser().parseColumnar(bytes.slice().buffer);
        const id = 'annotationId' in result ? result.annotationId : result.objectId;
        assert.equal(reopened.entities.getName(id), Name);
        assert.equal(reopened.entities.getTypeName(id), captured ? 'IfcBuildingElementProxy' : 'IfcAnnotation');
      }
    }
  } finally { api.free(); }
});
