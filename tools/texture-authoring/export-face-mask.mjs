/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Plan a face-masked evaluated conversion with the real wasm planner, apply it
// through the viewer's own entity application, and export the model as IFCZIP
// with its image (#4404). Used for the independent IfcOpenShell reopening of a
// masked opening-bearing product, which the browser acceptance does not cover.
//
// Usage (from the repo root, real wasm built):
//   TSX_TSCONFIG_PATH=apps/viewer/tsconfig.json node --import tsx --import ./apps/viewer/src/test/vite-module-hooks.mjs \
//     tools/texture-authoring/export-face-mask.mjs model.ifc <product-id> <first-half|0,1,2,...> out-directory
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initSync, IfcAPI } from '../../packages/wasm/pkg/ifc-lite.js';
import { IfcParser } from '../../packages/parser/dist/index.js';
import { MutablePropertyView, StoreEditor } from '../../packages/mutations/dist/index.js';
import { StepExporter } from '../../packages/export/dist/index.js';
import { applyAppearanceEntities } from '../../apps/viewer/src/lib/appearance/apply-plan.ts';
import { appearanceAssets, modelAppearanceAssets } from '../../apps/viewer/src/lib/appearance/model-assets.ts';
import { packagePortableIfc } from '../../apps/viewer/src/lib/export/portable-ifc.ts';

const [ifcPath, productText, maskText, outDir] = process.argv.slice(2);
const product = Number(productText);
if (!ifcPath || !Number.isInteger(product) || !maskText || !outDir) throw new Error('Usage: export-face-mask.mjs model.ifc <product-id> <first-half|ordinals> out-directory');
await mkdir(outDir, { recursive: true });
initSync({ module: await readFile(new URL('../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url)) });
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
const source = new Uint8Array(await readFile(ifcPath));
const data = await new IfcParser().parseColumnar(source.slice().buffer, { disableWorkerScan: true });
const view = new MutablePropertyView(data.properties, 'mask-export'), editor = new StoreEditor(data, view);
const asset = await appearanceAssets.add(png, { owner: { kind: 'source', id: 'export-face-mask' } });
const imageUri = modelAppearanceAssets.getAuthoredUri('mask-export', asset.id);
const request = { schema: 'IFC4', sourceRevision: 'mask-export', nextExpressId: view.peekNextExpressId(), productIds: [product], imageUri,
  repeatS: true, repeatT: true, representationPolicy: 'evaluatedOccurrence', mapping: { kind: 'box', frame: 'world', origin: [0, 0, 0], metresPerTile: [1, 1, 1] } };
const api = new IfcAPI();
let plan;
try {
  const whole = JSON.parse(new TextDecoder().decode(api.planAppearance(source, JSON.stringify(request))));
  if (whole.exclusions.length) throw new Error(`Whole-surface plan excluded the product: ${JSON.stringify(whole.exclusions)}`);
  const conversion = whole.conversions[0];
  const count = conversion.sourceIndices.length / 3;
  const triangles = maskText === 'first-half' ? Array.from({ length: Math.floor(count / 2) }, (_, i) => i) : maskText.split(',').map(Number);
  plan = JSON.parse(new TextDecoder().decode(api.planAppearance(source, JSON.stringify({ ...request,
    faceMasks: [{ productId: product, surfaceFingerprint: conversion.surfaceFingerprint, triangles }] }))));
  if (plan.exclusions.length) throw new Error(`Masked plan excluded the product: ${JSON.stringify(plan.exclusions)}`);
  await writeFile(path.join(outDir, `face-mask-plan-${product}.json`), JSON.stringify({ request: { ...request, faceMasks: [{ productId: product, surfaceFingerprint: conversion.surfaceFingerprint, triangles }] },
    conversion: { ...plan.conversions[0], sourcePositions: undefined, sourceNormals: undefined, sourceIndices: undefined, sourceRemovedMeshes: undefined },
    sourceTriangles: count, edits: plan.edits, created: plan.created.map(row => [row.expressId, row.type]), exclusions: plan.exclusions }, null, 2));
} finally { api.free(); }
applyAppearanceEntities(editor, view, plan, 'mask-export');
modelAppearanceAssets.registerAuthored('mask-export', 'command', [asset.id]);
const output = await new StepExporter(data, view).exportAsync({ schema: 'IFC4', applyMutations: true, includeGeometry: true });
const text = typeof output.content === 'string' ? output.content : new TextDecoder().decode(output.content);
const portable = packagePortableIfc('mask-export', text);
const target = path.join(outDir, `${path.basename(ifcPath, path.extname(ifcPath))}-mask-${product}.${portable.ext}`);
await writeFile(target, portable.content);
console.log(JSON.stringify({ export: target, edits: [...new Set(plan.edits.map(edit => edit.expressId))], textured: plan.conversions[0].geometryItemId,
  retained: plan.conversions[0].retainedGeometryItemId, maskedTriangles: plan.conversions[0].maskedTriangles.length, sourceTriangles: plan.conversions[0].sourceIndices.length / 3,
  removedMeshes: plan.conversions[0].sourceRemovedMeshes?.map(mesh => mesh.express_id) ?? [] }));
