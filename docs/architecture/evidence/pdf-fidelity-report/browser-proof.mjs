/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Fidelity-gated PDF vectors journey (#4406): run from the repository root
// against the local development viewer. Real UI actions register the `text`
// control page, read its report, accept the partial conversion, create the
// annotation, Undo/Redo, export the IFC and reopen it in a fresh tab; the
// exported file is then read by the IfcOpenShell oracle when python is present.
import { chromium } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const out = process.env.PROOF_OUT ?? path.join(process.env.TMPDIR ?? process.env.TEMP ?? '/tmp', 'pdf-fidelity-report-proof');
const target = process.env.PROOF_TARGET_IFC, pdf = process.env.PROOF_PDF;
if (!target || !pdf) throw new Error('Set PROOF_TARGET_IFC (an IFC4 model with a storey) and PROOF_PDF (control-text-accepted.pdf)');
const baseUrl = process.env.PROOF_URL ?? 'http://127.0.0.1:4390/';
fs.mkdirSync(out, { recursive: true });
const launch = { headless: true, args: ['--enable-gpu', '--enable-webgpu', '--enable-unsafe-webgpu', '--use-angle=default', '--ignore-gpu-blocklist'] };
if (process.env.PROOF_CHANNEL) launch.channel = process.env.PROOF_CHANNEL;
const browser = await chromium.launch(launch);
const viewport = { width: 1600, height: 1200 };
let page = await browser.newPage({ viewport, acceptDownloads: true });
page.setDefaultTimeout(60000);

// Module URLs inside evaluate resolve against Vite in the browser, not Node.
async function bind() {
  await page.evaluate(async () => {
    window.__pdfStore = (await import('/src/store/index.ts')).useViewerStore;
    const viewportModule = await (await fetch('/src/components/viewer/Viewport.tsx')).text();
    const hook = viewportModule.match(/from "([^"]*useBCF[^"]*)"/);
    const candidates = [...(hook ? [hook[1]] : []), ...performance.getEntriesByType('resource').map(e => e.name).filter(n => n.includes('/src/hooks/useBCF.')), '/src/hooks/useBCF.js', '/src/hooks/useBCF.ts'];
    for (const url of candidates) { const r = (await import(url)).getGlobalRenderer(); if (r) { window.__pdfRenderer = r; break; } }
  });
}
async function loaded() {
  await page.waitForFunction(() => { const s = window.__pdfStore?.getState(); return s?.models.size === 1 && [...s.models.values()][0].loadState === 'complete'; });
  await bind();
}
async function frame() {
  await page.evaluate(() => {
    const r = window.__pdfRenderer, s = window.__pdfStore.getState();
    s.setIsolatedEntities(new Set([window.__pdfObject]));
    const parts = r.getScene().getMeshDataPieces(window.__pdfObject), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const p of parts) for (let i = 0; i < p.positions.length; i += 3) for (let a = 0; a < 3; a++) { const v = p.positions[i + a] + (p.origin?.[a] ?? 0); min[a] = Math.min(min[a], v); max[a] = Math.max(max[a], v); }
    r.getCamera().setPresetView('front', { min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] } });
    r.requestRender();
  });
  await page.waitForTimeout(700);
}
async function pick() {
  const points = await page.evaluate(() => {
    const r = window.__pdfRenderer, rect = r.getCanvas().getBoundingClientRect();
    return r.getScene().getMeshDataPieces(window.__pdfObject).map(p => {
      const v = [0, 0, 0];
      for (let c = 0; c < 3; c++) for (let a = 0; a < 3; a++) v[a] += (p.positions[p.indices[c] * 3 + a] + (p.origin?.[a] ?? 0)) / 3;
      const q = r.getCamera().projectToScreen({ x: v[0], y: v[1], z: v[2] }, rect.width, rect.height);
      return { x: rect.x + q.x, y: rect.y + q.y };
    });
  });
  for (const p of points) {
    await page.mouse.click(p.x, p.y); await page.waitForTimeout(150);
    if (await page.evaluate(() => window.__pdfStore.getState().selectedEntityId === window.__pdfObject)) return p;
  }
  throw new Error('Normal pointer did not select the PDF annotation');
}
const geometryOf = () => page.evaluate(() => window.__pdfRenderer.getScene().getMeshDataPieces(window.__pdfObject).map(p => ({
  positions: [...p.positions], indices: [...p.indices], origin: p.origin ?? [0, 0, 0], color: p.color, hasTexture: !!p.textureRef })));

try {
  await page.goto(baseUrl); await bind();
  await page.locator('#file-input-open').setInputFiles(target); await loaded();
  await page.getByRole('tab', { name: 'Author', exact: true }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('button', { name: 'Place as reference', exact: true }).click();
  await page.getByLabel('Upload appearance source').setInputFiles(pdf);
  await page.waitForFunction(() => window.__pdfStore.getState().appearanceSources.some(s => s.pdf));
  const landmarks = page.getByRole('button', { name: 'Choose calibration landmarks on page' });
  await landmarks.scrollIntoViewIfNeeded();
  const box = await landmarks.locator('img').boundingBox();
  await page.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.5);
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.5);
  await page.getByLabel('Distance A–B (m)', { exact: true }).fill('2');
  await page.getByLabel('Projection plane').selectOption('xz');
  await page.getByRole('button', { name: 'Place reference', exact: true }).click();
  await page.waitForFunction(() => window.__pdfStore.getState().appearanceReferences.size === 1);
  await page.getByRole('button', { name: 'Remove source', exact: true }).click();
  await page.waitForFunction(() => window.__pdfStore.getState().appearanceSources.length === 0);
  await page.getByText('Save into model', { exact: true }).click();
  await page.getByLabel('Annotation representation').selectOption('fills');
  await page.getByLabel('Annotation Name').fill('PDF fidelity UI control');

  // 1. The report gates preparation: nothing is prepared until the omissions are accepted.
  await page.getByRole('button', { name: 'Prepare vector preview', exact: true }).click();
  const verdict = page.getByText(/^Partial conversion: 1 visible omission would be left out; 2 paths convert\.$/);
  await verdict.waitFor();
  const omissions = await page.getByRole('list', { name: 'PDF omissions' }).locator('li').allTextContents();
  // The control page declares /UserUnit 2, so its user-space extent [10, 16.4, 68.02, 32] is shown doubled in points.
  assert.deepEqual(omissions, ['1 × Text runs — region x 20–136.0, y 32.8–64 pt']);
  const prepare = page.getByRole('button', { name: 'Prepare partial conversion', exact: true });
  assert.equal(await prepare.isDisabled(), true, 'partial preparation stays disabled before acknowledgement');
  assert.equal(await page.getByRole('button', { name: 'Create annotation', exact: true }).count(), 0);
  await page.screenshot({ path: path.join(out, 'report.png') });
  const before = await page.evaluate(() => { const m = [...window.__pdfStore.getState().models.values()][0]; return { modelId: m.id, meshCount: m.geometryResult?.meshes.length ?? 0 }; });

  // 2. Explicit acceptance, native preview, creation.
  await page.getByLabel('Accept partial PDF conversion').check();
  assert.equal(await prepare.isDisabled(), false);
  await prepare.click();
  await page.getByRole('button', { name: 'Create annotation', exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Create annotation' && !b.disabled));
  await page.getByText(/^Review 2 coloured regions of the accepted partial conversion\./).waitFor();
  await page.getByLabel('PDF annotation geometry preview').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, 'preview.png') });
  await page.getByRole('button', { name: 'Create annotation', exact: true }).click();
  await page.getByText('Partial PDF IfcAnnotation created and selected; the accepted omissions are recorded in its IfcLite_PdfVectorConversion property set. Undo is available.', { exact: true }).waitFor();
  await bind();
  const created = await page.evaluate(() => {
    const s = window.__pdfStore.getState(), r = window.__pdfRenderer, id = s.selectedEntityId; window.__pdfObject = id;
    const ref = s.resolveGlobalIdFromModels(id), parts = r.getScene().getMeshDataPieces(id);
    return { ...ref, globalId: id, parts: parts.length, textureBatches: r.getScene().getTexturedMeshes().filter(p => p.expressId === id).length,
      flatBatches: r.getScene().getBatchedMeshes().filter(b => b.expressIds.includes(id)).length };
  });
  assert.equal(created.parts, 2); assert.equal(created.textureBatches, 0); assert.equal(created.flatBatches, 2);
  const createdGeometry = await geometryOf();

  // 3. Ordinary Undo/Redo, hidden drawing, pointer selection.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__pdfRenderer.getScene().getMeshDataPieces(window.__pdfObject)?.length ?? 0), 0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__pdfRenderer.getScene().getMeshDataPieces(window.__pdfObject)?.length), 2);
  const row = page.getByRole('region', { name: 'Registered drawings' }).locator('li').first();
  await row.getByRole('button', { name: /^Hide / }).click();
  await frame(); const createdPick = await pick();
  await page.screenshot({ path: path.join(out, 'created-selected.png') });

  // 4. Export, fresh-tab reopen through the ordinary loader, independent reader.
  await page.getByRole('tab', { name: 'File', exact: true }).click();
  await page.getByRole('button', { name: 'Export IFC (with changes)', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloading, filename = download.suggestedFilename(), exported = path.join(out, filename);
  await download.saveAs(exported);
  await page.close();
  page = await browser.newPage({ viewport, acceptDownloads: true }); page.setDefaultTimeout(60000);
  await page.goto(baseUrl); await bind();
  await page.locator('#file-input-open').setInputFiles(exported); await loaded();
  const reopened = await page.evaluate(expressId => {
    const s = window.__pdfStore.getState(), m = [...s.models.values()][0], id = s.toGlobalId(m.id, expressId); window.__pdfObject = id;
    return { type: m.ifcDataStore.entities.getTypeName(expressId), name: m.ifcDataStore.entities.getName(expressId),
      geometry: m.geometryResult.meshes.filter(p => p.expressId === id).map(p => ({ positions: [...p.positions], indices: [...p.indices], origin: p.origin ?? [0, 0, 0], color: p.color, hasTexture: !!p.textureRef })) };
  }, created.expressId);
  assert.equal(reopened.type, 'IfcAnnotation'); assert.equal(reopened.name, 'PDF fidelity UI control'); assert.equal(reopened.geometry.length, 2);
  let worldError = 0;
  for (const a of createdGeometry) {
    const b = reopened.geometry.find(p => p.color.every((v, i) => Math.abs(v - a.color[i]) < 1e-7));
    assert.ok(b); assert.equal(a.indices.length, b.indices.length);
    for (let c = 0; c < a.indices.length; c++) for (let axis = 0; axis < 3; axis++)
      worldError = Math.max(worldError, Math.abs(a.positions[a.indices[c] * 3 + axis] + a.origin[axis] - b.positions[b.indices[c] * 3 + axis] - b.origin[axis]));
  }
  assert.ok(worldError < 1e-6);
  await frame(); const reopenedPick = await pick();
  await page.screenshot({ path: path.join(out, 'reopened-selected.png') });
  let oracle = null;
  if (filename.endsWith('.ifc')) {
    const run = spawnSync(process.env.PROOF_PYTHON ?? 'python', ['tools/texture-authoring/pdf-fidelity-oracle.py', exported, path.join(out, 'reopened-oracle.json')], { encoding: 'utf8' });
    if (run.status === 0) {
      oracle = JSON.parse(fs.readFileSync(path.join(out, 'reopened-oracle.json'), 'utf8'));
      const provenance = oracle.annotations[0].provenance;
      assert.equal(oracle.annotations[0].Name, 'PDF fidelity UI control');
      assert.equal(oracle.annotations[0].Description, 'PDF vectors, page 1: partial conversion; omitted 1 text run');
      assert.equal(provenance.AcceptedPartialConversion, true); assert.equal(provenance.ExactConversion, false);
      assert.equal(provenance.ToleranceMetres, 0.001);
      assert.deepEqual(JSON.parse(provenance.Omissions), [{ kind: 'text', count: 1, visible: 1 }]);
    } else { oracle = { skipped: (run.stderr || run.error?.message || '').trim().split('\n').pop() }; }
  }
  fs.writeFileSync(path.join(out, 'journey.json'), JSON.stringify({ browser: await browser.version(), before, omissions, created, createdPick, filename, reopened: { ...reopened, geometry: undefined }, reopenedPick, worldError, oracle }, null, 2));
  console.log(`PASS report shown, partial acceptance required, native preview/create, Undo/Redo, picking, export/reopen${oracle && !oracle.skipped ? ', IfcOpenShell provenance' : ' (oracle skipped)'}`);
} catch (error) {
  fs.writeFileSync(path.join(out, 'failure.txt'), await page.locator('body').innerText());
  await page.screenshot({ path: path.join(out, 'failure.png') });
  throw error;
} finally { await browser.close(); }
