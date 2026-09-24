/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createRequire } from 'node:module';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const checkout = process.env.WITNESS_CHECKOUT;
if (!checkout) throw new Error('WITNESS_CHECKOUT is required');
const require = createRequire(join(checkout, 'package.json'));
const { chromium } = require('@playwright/test');

const origin = process.env.WITNESS_ORIGIN ?? 'http://127.0.0.1:5275';
const fixture = process.env.WITNESS_FIXTURE;
if (!fixture) throw new Error('WITNESS_FIXTURE is required');
const isHolter = fixture.includes('ISSUE_053_20181220Holter_Tower_10.ifc');
const output = process.argv[2];
if (!output) throw new Error('output prefix argument is required');
const chrome = process.env.WITNESS_CHROME;
if (!chrome) throw new Error('WITNESS_CHROME is required');
const startGate = process.env.WITNESS_START_GATE;
const loadGate = process.env.WITNESS_LOAD_GATE;
const loadReady = process.env.WITNESS_LOAD_READY;
if (startGate) {
  const gateDeadline = Date.now() + 10_000;
  while (!existsSync(startGate) && Date.now() < gateDeadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (!existsSync(startGate)) throw new Error(`Affinity gate never opened: ${startGate}`);
}
const logs: { ms: number; type: string; text: string }[] = [];
const pageErrors: string[] = [];
const httpErrors: { status: number; url: string }[] = [];
const navigations: number[] = [];
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ['--enable-gpu', '--enable-webgpu', '--enable-unsafe-webgpu', '--use-angle=default', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext();
const page = await context.newPage();
// Windows tsx/esbuild wraps function literals passed to page.evaluate with
// this helper, which must also exist in the isolated browser evaluation.
await page.addInitScript('window.__name = (fn) => fn');
let start = 0;
page.on('console', (message: { type(): string; text(): string }) => {
  logs.push({ ms: start ? Date.now() - start : -1, type: message.type(), text: message.text() });
});
page.on('pageerror', (error: Error) => pageErrors.push(error.message));
page.on('response', (response: { status(): number; url(): string }) => {
  if (response.status() >= 400) httpErrors.push({ status: response.status(), url: response.url() });
});
page.on('framenavigated', (frame: { parentFrame(): unknown }) => {
  if (!frame.parentFrame() && start) navigations.push(Date.now() - start);
});

try {
  await page.goto(origin, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.locator('input[type="file"]').first().waitFor({ state: 'attached' });
  await page.waitForFunction(() => !!window.__ifcLiteWitness, undefined, { timeout: 30_000 });
  const isolated = await page.evaluate(() => ({
    crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
    userAgent: navigator.userAgent,
  }));
  if (loadGate && loadReady) {
    writeFileSync(loadReady, 'browser-ready');
    const gateDeadline = Date.now() + 10_000;
    while (!existsSync(loadGate) && Date.now() < gateDeadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (!existsSync(loadGate)) throw new Error(`Load gate never opened: ${loadGate}`);
  }
  start = Date.now();
  await page.locator('input[type="file"]').first().setInputFiles(fixture);
  const diagnosticDeadline = start + 60_000;
  let complete: Record<string, unknown> | null = null;
  let modelCompleteMs: number | null = null;
  let spatialIndexReadyMs: number | null = null;
  let canvasReadyMs: number | null = null;
  while (Date.now() < diagnosticDeadline) {
    complete = await page.evaluate(async () => {
      const state = window.__ifcLiteWitness.getState();
      const model = state.models.get(state.activeModelId ?? '');
      if (!model) return null;
      const canvas = document.querySelector('canvas');
      return {
        activeModelId: state.activeModelId,
        modelCount: state.models.size,
        loadState: model.loadState,
        loadPath: model.loadPath,
        flatMeshCount: model.geometryResult?.meshes.length ?? null,
        totalTriangles: model.geometryResult?.totalTriangles ?? null,
        spatialIndexReady: !!model.ifcDataStore?.spatialIndex,
        canvasReady: !!canvas && canvas.width > 0 && canvas.height > 0,
        pendingInstancedShardCount: state.pendingInstancedShards?.length ?? 0,
      };
    });
    if (complete?.loadState === 'complete' && modelCompleteMs === null) modelCompleteMs = Date.now() - start;
    if (complete?.spatialIndexReady && spatialIndexReadyMs === null) spatialIndexReadyMs = Date.now() - start;
    if (complete?.canvasReady && canvasReadyMs === null) canvasReadyMs = Date.now() - start;
    if (modelCompleteMs !== null && spatialIndexReadyMs !== null && canvasReadyMs !== null &&
      (!isHolter || logs.some(log => log.text.includes('[GeomSync] finalize complete')))) break;
    await page.waitForTimeout(100);
  }
  const fullyReadyMs = Date.now() - start;
  const target = await page.evaluate(async () => {
    const state = window.__ifcLiteWitness.getState();
    const getGlobalRenderer = window.__ifcLiteWitness.getRenderer;
    const model = state.models.get(state.activeModelId ?? '');
    const scene = getGlobalRenderer()?.getScene();
    const id = 148571 + (model?.idOffset ?? 0);
    const pieces = scene?.getMeshDataPieces(id) ?? scene?.getInstancedMeshDataPieces(id) ?? [];
    const index = model?.ifcDataStore?.spatialIndex;
    const balances = new Map<string, number>();
    let triangles = 0;
    let vertices = 0;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const quantize = (n: number) => Math.round(n * 1000); // viewer metres; 1 mm weld grid
    for (const piece of pieces) {
      const p = piece.positions as Float32Array;
      const indices = piece.indices as Uint32Array;
      for (let i = 0; i < p.length; i += 3) for (let a = 0; a < 3; a++) {
        const placed = p[i + a] + (piece.origin?.[a] ?? 0);
        min[a] = Math.min(min[a], placed); max[a] = Math.max(max[a], placed);
      }
      vertices += p.length / 3;
      triangles += indices.length / 3;
      const vertex = (i: number) => `${quantize(p[i * 3])},${quantize(p[i * 3 + 1])},${quantize(p[i * 3 + 2])}`;
      for (let t = 0; t < indices.length; t += 3) {
        const v = [vertex(indices[t]), vertex(indices[t + 1]), vertex(indices[t + 2])];
        for (const [a, b] of [[v[0], v[1]], [v[1], v[2]], [v[2], v[0]]]) {
          const key = a < b ? `${a}|${b}` : `${b}|${a}`;
          balances.set(key, (balances.get(key) ?? 0) + (a < b ? 1 : -1));
        }
      }
    }
    const openEdges = [...balances.values()].filter(value => value !== 0).length;
    const eps = 0.001;
    const queryHits = index && pieces.length ? index.queryAABB({
      min: min.map(v => v - eps), max: max.map(v => v + eps),
    }) : [];
    return { id, pieces: pieces.length, vertices, triangles, openEdges,
      sceneTargetPresent: pieces.length > 0, spatialIndexReady: !!index,
      queryHits, indexContainsTarget: queryHits.includes(id), bounds: { min, max }, origin: pieces[0]?.origin ?? null };
  });
  // Post-readiness oracle: read what the user actually sees, then exercise GPU
  // picking and the ordinary click-to-properties path. None of this is in the
  // first-load readiness time above.
  const visibleUi = await page.evaluate(() => {
    const text = document.body.innerText;
    const spans = [...document.querySelectorAll('span')].map(el => el.textContent?.trim() ?? '');
    const lastExact = (pattern: RegExp) => spans.filter(value => pattern.test(value)).at(-1) ?? null;
    const exactRow = (label: string) => {
      const span = [...document.querySelectorAll('span')].find(el => el.textContent?.trim().toLowerCase() === label.toLowerCase());
      return span?.parentElement?.lastElementChild?.textContent?.trim() ?? null;
    };
    return {
      statusElements: lastExact(/^[\d,.K]+\s+elements$/i),
      statusTriangles: lastExact(/^[\d,.K]+\s+tris$/i),
      hierarchyHeader: text.match(/HIERARCHY\s*\n?\s*[\d,.]+/i)?.[0] ?? null,
      totalEntities: exactRow('Total Entities'),
      buildingStoreys: exactRow('Building Storeys'),
      elementsWithGeometry: exactRow('Elements with Geometry'),
      metadataPanelVisible: text.includes('PROJECT INFORMATION') && text.includes('STATISTICS'),
    };
  });
  const gpuPick = await page.evaluate(async () => {
    const renderer = window.__ifcLiteWitness.getRenderer();
    const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => {
      const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
      return br.width * br.height - ar.width * ar.height;
    })[0];
    if (!renderer || !canvas) return { hit: null, reason: 'missing renderer or canvas' };
    const rect = canvas.getBoundingClientRect();
    for (const [fx, fy] of [[0.5, 0.5], [0.4, 0.5], [0.6, 0.5], [0.5, 0.7], [0.35, 0.65], [0.65, 0.65], [0.5, 0.35]]) {
      const x = Math.round(rect.width * fx), y = Math.round(rect.height * fy);
      const hit = await renderer.pick(x, y);
      if (hit) return { hit, pageX: rect.x + x, pageY: rect.y + y, canvasWidth: rect.width, canvasHeight: rect.height };
    }
    return { hit: null, reason: 'seven GPU picks missed visible geometry', canvasWidth: rect.width, canvasHeight: rect.height };
  });
  let selection: Record<string, unknown> | null = null;
  if ('pageX' in gpuPick && typeof gpuPick.pageX === 'number' && typeof gpuPick.pageY === 'number') {
    await page.mouse.click(gpuPick.pageX, gpuPick.pageY);
    await page.waitForTimeout(250);
    selection = await page.evaluate(async () => {
      const state = window.__ifcLiteWitness.getState();
      const panelText = document.body.innerText;
      return {
        selectedEntityId: state.selectedEntityId,
        selectedEntity: state.selectedEntity,
        selectedEntityIds: [...state.selectedEntityIds],
        propertiesVisible: /PROPERTIES|ATTRIBUTES|NAME|GLOBALID/i.test(panelText),
        propertiesTextTail: panelText.slice(-1500),
      };
    });
  }
  const streamLog = logs.find(log => log.text.includes('[useIfc] Geometry streaming complete'));
  const finalLog = logs.find(log => /\[ifc-lite\].*→\s*\d[\d,]*\s*meshes.*in\s*[\d.]+s/.test(log.text));
  const consolidatedLog = logs.find(log => log.text.includes('[GeomSync] finalize complete'));
  const outcome = {
    ok: (!isHolter || fullyReadyMs <= 14_000) && complete?.loadState === 'complete' && !!complete.spatialIndexReady &&
      !!complete.canvasReady && !!streamLog && (!isHolter || !!consolidatedLog) && (!isHolter || target.sceneTargetPresent) &&
      (!isHolter || (target.openEdges === 0 && target.indexContainsTarget)) && pageErrors.length === 0 && navigations.length === 0,
    fullyReadyMs, modelCompleteMs, spatialIndexReadyMs, canvasReadyMs,
    streamCompleteMs: streamLog?.ms ?? null, finalSummaryMs: finalLog?.ms ?? null,
    consolidatedMs: consolidatedLog?.ms ?? null,
    streamLog: streamLog?.text ?? null, finalLog: finalLog?.text ?? null,
    browserVersion: browser.version(), isolated, complete, target, pageErrors, httpErrors, navigations,
    fixture, isHolter, visibleUi, gpuPick, selection,
    consoleErrors: logs.filter(log => log.type === 'error'),
  };
  await page.screenshot({ path: `${output}.png` });
  writeFileSync(`${output}.json`, JSON.stringify(outcome, null, 2));
  writeFileSync(`${output}.console.log`, logs.map(log => `${log.ms}ms ${log.type}: ${log.text}`).join('\n'));
  console.log(JSON.stringify(outcome, null, 2));
  if (!outcome.ok) process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
