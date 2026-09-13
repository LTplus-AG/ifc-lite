/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { IfcParser, unwrapIfcZipWithResources } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { GeometryProcessor, type MeshData } from '@ifc-lite/geometry';
import { applyAppearanceEntities } from './apply-plan.js';
import { appearanceAssets, modelAppearanceAssets } from './model-assets.js';
import { packagePortableIfc } from '../export/portable-ifc.js';
import type { AppearancePlan, AppearanceRequest } from './planner-types.js';

const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));

/**
 * The exported file of a face-masked member reopens through the same parser
 * and wasm geometry pipeline the viewer's loader uses (#4404): the product
 * tessellates into its textured and its retained face set, both owned by the
 * product, the portable archive carries the image, and every sibling member
 * of the shared type is byte-identical to the original load.
 */
test('real AC20 face-masked export reopens as textured + retained parts of one product with siblings unchanged (#4404)', async t => {
  const wasmUrl = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
  const sourceUrl = new URL('../../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
  try { await Promise.all([access(wasmUrl), access(sourceUrl)]); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    t.skip('Run pnpm fixtures and pnpm build:wasm for the real face-mask reopen contract'); return;
  }
  const source = new Uint8Array(await readFile(sourceUrl));
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(wasmUrl) });
  const store = await new IfcParser().parseColumnar(source.slice().buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(store.properties, 'AC20');
  const editor = new StoreEditor(store, view);
  const asset = await appearanceAssets.add(png, { owner: { kind: 'source', id: 'face-mask-reopen' } });
  const imageUri = modelAppearanceAssets.getAuthoredUri('AC20', asset.id);
  const request: AppearanceRequest = { schema: 'IFC4', sourceRevision: 'AC20-mask-reopen', nextExpressId: view.peekNextExpressId(),
    productIds: [35169], imageUri, repeatS: true, repeatT: true, representationPolicy: 'evaluatedOccurrence',
    mapping: { kind: 'box', frame: 'world', origin: [0, 0, 0], metresPerTile: [1, 1, 1] } };
  const api = new IfcAPI();
  let plan: AppearancePlan;
  try {
    const whole = JSON.parse(new TextDecoder().decode(api.planAppearance(source, JSON.stringify(request)))) as AppearancePlan;
    assert.deepEqual(whole.exclusions, []);
    const fingerprint = whole.conversions![0].surfaceFingerprint!;
    // Half of the member's twelve canonical triangles receive the image.
    plan = JSON.parse(new TextDecoder().decode(api.planAppearance(source, JSON.stringify({ ...request,
      faceMasks: [{ productId: 35169, surfaceFingerprint: fingerprint, triangles: [0, 1, 2, 3, 4, 5] }] })))) as AppearancePlan;
  } finally { api.free(); }
  assert.deepEqual(plan.exclusions, []);
  const conversion = plan.conversions![0];
  assert.deepEqual(conversion.maskedTriangles, [0, 1, 2, 3, 4, 5]);
  const textured = conversion.geometryItemId, retained = conversion.retainedGeometryItemId!;

  const processor = new GeometryProcessor();
  let before: MeshData[], after: MeshData[], archive: Awaited<ReturnType<typeof unwrapIfcZipWithResources>>;
  try {
    await processor.init();
    before = (await processor.process(source.slice())).meshes;
    applyAppearanceEntities(editor, view, plan, 'AC20-mask-reopen');
    modelAppearanceAssets.registerAuthored('AC20', 'mask-command', [asset.id]);
    const output = await new StepExporter(store, view).exportAsync({ schema: 'IFC4', applyMutations: true, includeGeometry: true });
    const text = typeof output.content === 'string' ? output.content : new TextDecoder().decode(output.content);
    const portable = packagePortableIfc('AC20', text);
    assert.equal(portable.ext, 'ifczip');
    archive = await unwrapIfcZipWithResources(new Uint8Array(portable.content as Uint8Array).buffer);
    after = (await processor.process(new Uint8Array(archive.model))).meshes;
  } finally { processor.dispose(); modelAppearanceAssets.clear(); appearanceAssets.clear(); }

  // The exported archive carries the image next to the model.
  assert.deepEqual([...archive.originalResources.values()], [png]);
  const reopened = await new IfcParser().parseColumnar(archive.model, { disableWorkerScan: true });
  assert.equal(reopened.entities.getGlobalId(35169), store.entities.getGlobalId(35169), 'the product keeps its identity');
  assert.ok(reopened.entities.hasGeometry(35169));
  const memberBefore = before.filter(mesh => mesh.expressId === 35169);
  const memberAfter = after.filter(mesh => mesh.expressId === 35169);
  assert.equal(memberBefore.length, 1); assert.equal(memberBefore[0].indices.length, 36);
  assert.deepEqual(memberAfter.map(mesh => mesh.geometryItemId ?? -1).sort((a, b) => a - b), [textured, retained].sort((a, b) => a - b), 'two items under one product');
  const texturedMesh = memberAfter.find(mesh => mesh.geometryItemId === textured)!, retainedMesh = memberAfter.find(mesh => mesh.geometryItemId === retained)!;
  assert.equal(texturedMesh.indices.length, 18); assert.equal(retainedMesh.indices.length, 18);
  assert.equal(texturedMesh.textureRef?.url, imageUri, 'the textured face set binds the portable image');
  assert.ok(texturedMesh.uvs && texturedMesh.uvs.length === texturedMesh.positions.length / 3 * 2);
  assert.equal(retainedMesh.textureRef, undefined); assert.equal(retainedMesh.texture, undefined); assert.equal(retainedMesh.uvs, undefined);
  assert.deepEqual(retainedMesh.color, memberBefore[0].color, 'the retained face set keeps the source colour');
  // Every reopened corner of both face sets is a corner of the original member, and
  // every original corner appears exactly once across the two face sets.
  const corners = (meshes: readonly MeshData[]) => {
    const counts = new Map<string, number>();
    for (const mesh of meshes) for (let corner = 0; corner < mesh.indices.length; corner++) {
      const key = [0, 1, 2].map(axis => (mesh.positions[mesh.indices[corner] * 3 + axis] + (mesh.origin?.[axis] ?? 0)).toFixed(5)).join(',');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  assert.deepEqual(corners([texturedMesh, retainedMesh]), corners(memberBefore));
  // Picking any part resolves to the product; the 41 sibling members are untouched.
  assert.ok(memberAfter.every(mesh => mesh.expressId === 35169));
  const siblings = [...new Set(before.filter(mesh => store.entities.getTypeName(mesh.expressId) === 'IfcMember' && mesh.expressId !== 35169).map(mesh => mesh.expressId))];
  assert.equal(siblings.length, 41);
  for (const sibling of siblings) {
    const a = before.filter(mesh => mesh.expressId === sibling), b = after.filter(mesh => mesh.expressId === sibling);
    assert.equal(a.length, b.length);
    a.forEach((mesh, index) => { assert.deepEqual([...mesh.positions], [...b[index].positions]); assert.deepEqual([...mesh.indices], [...b[index].indices]); assert.deepEqual(mesh.color, b[index].color); });
  }
  assert.equal(after.length, before.length + 1, 'the split adds exactly one mesh to the model');
});
