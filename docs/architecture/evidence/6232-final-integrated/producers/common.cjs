// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { metadataGraph } = require('./metadata-graph.cjs');
const root = fs.realpathSync(process.env.IFC_SOURCE_ROOT || process.cwd());
const baseURL = process.env.IFC_VIEWER_URL || 'http://127.0.0.1:5189';
const evidenceRoot = path.resolve(process.env.IFC_EVIDENCE_DIR || '/tmp/6232-final-evidence');
const fixturePath = path.join(root, 'apps/viewer/public/samples/hello-wall.ifc');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (...args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function sourceReceipt() {
  const wasm = path.join(root, 'packages/wasm/pkg/ifc-lite_bg.wasm');
  return { head: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain'), rustTree: git('rev-parse', 'HEAD:rust'),
    fixturePath, fixtureSHA256: hash(fs.readFileSync(fixturePath)),
    wasmSHA256: hash(fs.readFileSync(wasm)), wasmModified: fs.statSync(wasm).mtime.toISOString(), sourceRoot: root, baseURL };
}
function guards() {
  assert.equal(process.env.IFC_FINAL_CAPTURE_TOKEN, 'FINAL_SOURCE_READY', 'Wait for the final integrated source/WASM; do not produce stale receipts.');
  assert.ok(process.env.IFC_EXPECTED_HEAD, 'Set IFC_EXPECTED_HEAD to the root-qualified integrated commit.');
  const receipt = sourceReceipt();
  assert.equal(receipt.head, process.env.IFC_EXPECTED_HEAD);
  assert.equal(receipt.dirty, '', 'The integrated capture source must be committed and clean.');
  return receipt;
}
async function runSuite(name, exercise) {
  const source = guards(), { chromium } = require(path.join(root, 'node_modules/@playwright/test'));
  const dir = path.join(evidenceRoot, name); fs.mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.IFC_CHROME || '/usr/bin/google-chrome', headless: false,
    args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--enable-gpu'] });
  try {
    for (const count of [1, 2]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage(), logs = [], wasmResponses = [], networkTasks = [];
      page.on('console', msg => logs.push(`${msg.type()}: ${msg.text()}`));
      page.on('pageerror', error => logs.push(`PAGEERROR ${error}`));
      context.on('response', response => {
        if (response.url().includes('ifc-lite_bg.wasm')) networkTasks.push(response.body().then(bytes => {
          wasmResponses.push({ url: response.url(), status: response.status(), sha256: hash(bytes), bytes: bytes.length });
        }, error => { logs.push(`WASM_RECEIPT_ERROR ${error}`); }));
      });
      try {
        await page.goto(baseURL);
        await page.waitForFunction(() => !!globalThis.__ifc_lite_viewer_store__);
        for (let i = 1; i <= count; i++) {
          await page.locator(i === 1 ? '#file-input-open' : '#file-input-add').setInputFiles(fixturePath);
          await page.waitForFunction(n => {
            const s = globalThis.__ifc_lite_viewer_store__.getState();
            return s.models.size === n && [...s.models.values()].every(m => m.ifcDataStore && m.geometryResult?.meshes.length) && !s.isLoading;
          }, i, { timeout: 120000 });
        }
        await page.getByRole('tab', { name: 'Author', exact: true }).click();
        await page.getByRole('tabpanel', { name: 'Author' }).getByRole('button', { name: 'Model', exact: true }).click();
        await page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__.getState().editEnabled);
        const modelId = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().activeModelId);
        assert.ok(modelId);
        await page.evaluate(async root => {
          const url = file => '/@fs' + root + '/' + file;
          const [{ BroadcastTransport }, { StepExporter }, { getCompleteEntityIndex }, parser, geometry, frame] = await Promise.all([
            import(url('packages/sdk/src/transport/broadcast.ts')), import(url('packages/export/src/step-exporter.ts')),
            import(url('packages/export/src/entity-iteration.ts')), import(url('packages/parser/src/index.ts')),
            import(url('packages/geometry/src/index.ts')), import(url('packages/create/src/index.ts')),
          ]);
          globalThis.parityImports = { StepExporter, getCompleteEntityIndex, ...parser, GeometryProcessor: geometry.GeometryProcessor,
            roomFramePlanOffsets: frame.roomFramePlanOffsets, roomFrameToModelWorld: frame.roomFrameToModelWorld,
            storeyPlanFrame: frame.storeyPlanFrame, toStoreyLocal: frame.toStoreyLocal };
          globalThis.parityTransport = new BroadcastTransport('ifc-lite', { timeoutMs: 120000 });
          globalThis.parityNativeProcessor = new geometry.GeometryProcessor({ enableInstancing: false });
          await globalThis.parityNativeProcessor.init();
        }, root);
        // Observe the real worker pipeline; never enqueue a remesh from this harness.
        await page.evaluate(async root => {
          const { RemeshClient } = await import('/@fs' + root + '/packages/geometry/src/remesh/index.ts');
          globalThis.parityRemesh = { pending: 0, started: 0, finished: 0, errors: [] };
          for (const [owner, key] of [[RemeshClient, 'create'], [RemeshClient.prototype, 'styleWire'], [RemeshClient.prototype, 'remesh']]) {
            const original = owner[key];
            owner[key] = function (...args) {
              const trace = globalThis.parityRemesh; trace.pending++; trace.started++;
              let promise;
              try { promise = original.apply(this, args); }
              catch (error) { trace.pending--; trace.errors.push(String(error)); throw error; }
              void promise.then(() => { trace.pending--; trace.finished++; }, error => { trace.pending--; trace.errors.push(String(error)); });
              return promise;
            };
          }
        }, root);
        await page.evaluate(source => {
          globalThis.parityMetadataGraph = new Function('return (' + source + ')')();
        }, metadataGraph.toString());
        const proofs = [], calls = []; let sequence = 0;
        const send = async (method, args) => {
          const reply = await page.evaluate(request => globalThis.parityTransport.send(request), {
            id: `6232-${name}-${count}-${++sequence}`, namespace: 'store', method, args,
          });
          calls.push({ method, args, reply });
          assert.ok(!reply.error, JSON.stringify(reply.error));
          return reply.result;
        };
        const settle = async () => {
          await page.waitForFunction(() => {
            const s = globalThis.__ifc_lite_viewer_store__.getState();
            return !s.isLoading && !s.pendingMeshRemovals && !s.pendingMeshEdits;
          }, null, { timeout: 30000 });
          await page.waitForFunction(async () => {
            const trace = globalThis.parityRemesh;
            if (trace.pending) return false;
            const started = trace.started;
            // Let the service apply the returned meshes and the renderer drain
            // them. Animation frames are barriers, not fixed-duration sleeps.
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const s = globalThis.__ifc_lite_viewer_store__.getState();
            return !trace.pending && trace.started === started && !s.pendingMeshRemovals && !s.pendingMeshEdits;
          }, null, { timeout: 120000 });
          const errors = await page.evaluate(() => globalThis.parityRemesh.errors);
          assert.deepEqual(errors, [], 'Actual automatic re-mesh worker must complete without errors');
        };
        const witness = async nativeIds => page.evaluate(async ({ modelId, nativeIds }) => {
          const s = globalThis.__ifc_lite_viewer_store__.getState(), imports = globalThis.parityImports;
          const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
          const worldBounds = (meshes, coord, ids, label) => {
            const { cx, cy } = imports.roomFramePlanOffsets(coord), { dx, dy } = imports.roomFrameToModelWorld(coord);
            return ids.map(id => {
              const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]; let vertices = 0, triangles = 0;
              for (const mesh of meshes.filter(mesh => mesh.expressId === id)) {
                const origin = mesh.origin ?? [0,0,0]; triangles += mesh.indices.length / 3;
                for (let i = 0; i < mesh.positions.length; i += 3) {
                  const p = [mesh.positions[i] + origin[0] + cx + dx, -mesh.positions[i+2] - origin[2] + cy + dy,
                    mesh.positions[i+1] + origin[1] + (coord?.originShift?.y ?? 0) + (coord?.wasmRtcOffset?.z ?? 0)];
                  for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], p[axis]); max[axis] = Math.max(max[axis], p[axis]); }
                  vertices++;
                }
              }
              if (!vertices || ![...min,...max].every(Number.isFinite)) throw new Error(`Missing ${label} mesh #${id}; available=${meshes.map(mesh=>mesh.expressId).join(',')}`);
              return { id, min, max, vertices, triangles };
            });
          };
          const historySteps = stack => {
            let count = 0, previous;
            for (const mutation of stack ?? []) {
              const tag = s.mutationBatchTags.get(mutation.id);
              if (tag === undefined || tag !== previous) count++;
              previous = tag;
            }
            return count;
          };
          const models = [];
          for (const [key, model] of s.models) {
            const view = s.mutationViews.get(key), bytes = new imports.StepExporter(model.ifcDataStore, view).export({ schema: model.ifcDataStore.schemaVersion ?? 'IFC4', applyMutations: true, timeStamp: '2026-10-03T00:00:00' }).content;
            const parsed = await new imports.IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
            const extractor = new imports.EntityExtractor(parsed.source), graph = [...imports.getCompleteEntityIndex(parsed)].map(([id, location]) => {
              const row = extractor.extractEntity({ ...location, expressId: id, lineNumber: 0 }); if (!row) throw new Error(`Unreadable exported entity #${id}`);
              return { id, type: row.type, attributes: row.attributes };
            }).sort((a,b) => a.id-b.id);
            const persistentIds = new Set([...imports.getCompleteEntityIndex(model.ifcDataStore)].map(([id]) => id));
            for (const record of view?.getNewEntities() ?? []) persistentIds.add(record.expressId);
            const canonicalGraph = globalThis.parityMetadataGraph(graph, persistentIds);
            const meshes = [];
            for (const mesh of model.geometryResult?.meshes ?? []) {
              const ref = s.resolveGlobalIdFromModels(mesh.expressId);
              if (!ref || ref.modelId !== key) throw new Error(`Mesh ${mesh.expressId} is not owned by ${key}`);
              meshes.push({ globalId: mesh.expressId, localId: ref.expressId, origin: mesh.origin ?? [0,0,0],
                triangles: mesh.indices.length/3, hash: await digest({ positions: Array.from(mesh.positions), indices: Array.from(mesh.indices),
                  normals: mesh.normals ? Array.from(mesh.normals) : [], color: mesh.color, origin: mesh.origin }) });
            }
            meshes.sort((a,b) => a.globalId-b.globalId || a.hash.localeCompare(b.hash));
            const result = { modelId: key, schema: model.ifcDataStore.schemaVersion, graph, canonicalGraph, syntheticMetadataIds: graph.filter(row => !persistentIds.has(row.id)).map(row => row.id), graphHash: await digest(canonicalGraph), meshes,
              geometryHash: await digest({ meshes, coordinateInfo: model.geometryResult?.coordinateInfo }), coordinateInfo: model.geometryResult?.coordinateInfo,
              records: structuredClone(view?.getNewEntities() ?? []).sort((a,b)=>a.expressId-b.expressId), journal: structuredClone(view?.getMutations() ?? []),
              allocator: view?.peekNextExpressId(), undo: historySteps(s.undoStacks.get(key)), redo: historySteps(s.redoStacks.get(key)), undoRows: s.undoStacks.get(key)?.length ?? 0, redoRows: s.redoStacks.get(key)?.length ?? 0 };
            if (key === modelId && nativeIds?.length) {
              const native = await globalThis.parityNativeProcessor.process(bytes), wanted = [...new Set(nativeIds)];
              result.sourceNative = { exportedSHA256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join(''), coordinateInfo: native.coordinateInfo,
                bounds: worldBounds(native.meshes, native.coordinateInfo, wanted, 'source native') };
              const localMeshes = (model.geometryResult?.meshes ?? []).map(mesh => ({ ...mesh, expressId: s.resolveGlobalIdFromModels(mesh.expressId).expressId }));
              result.displayedBounds = worldBounds(localMeshes, model.geometryResult?.coordinateInfo, wanted, 'displayed');
              const plan = imports.storeyPlanFrame(parsed, 42);
              if (!plan) throw new Error('No upright storey frame for native receipt');
              result.storeyPlan = plan;
              result.planBounds = [];
              const { cx, cy } = imports.roomFramePlanOffsets(native.coordinateInfo), { dx, dy } = imports.roomFrameToModelWorld(native.coordinateInfo);
              for (const id of wanted) {
                const min = [Infinity,Infinity], max = [-Infinity,-Infinity];
                for (const mesh of native.meshes.filter(mesh=>mesh.expressId===id)) {
                  const origin = mesh.origin ?? [0,0,0];
                  for(let i=0;i<mesh.positions.length;i+=3) {
                    const p = imports.toStoreyLocal(plan,[mesh.positions[i]+origin[0]+cx+dx,-mesh.positions[i+2]-origin[2]+cy+dy]);
                    for(let axis=0;axis<2;axis++){ min[axis]=Math.min(min[axis],p[axis]); max[axis]=Math.max(max[axis],p[axis]); }
                  }
                }
                result.planBounds.push({ id, min, max });
              }
            }
            models.push(result);
          }
          return models;
        }, { modelId, nativeIds });
        await settle(); const baseline = await witness([]), peerBaseline = baseline.filter(model => model.modelId !== modelId);
        const capture = async (stage, nativeIds = []) => {
          await settle();
          let models, target;
          const deadline = Date.now() + 120000;
          for (;;) {
            try {
              models = await witness(nativeIds);
              assert.deepEqual(models.filter(model => model.modelId !== modelId), peerBaseline, 'peer source, overlay, native mesh, history and allocator must remain unchanged');
              target = models.find(model => model.modelId === modelId);
              if (target.sourceNative) for (const native of target.sourceNative.bounds) {
                const shown = target.displayedBounds.find(box => box.id === native.id); assert.ok(shown);
                assert.ok(native.triangles > 0 && shown.triangles > 0);
                assert.equal(shown.triangles, native.triangles, `Fresh source vs displayed ${stage} #${native.id} triangle count`);
                assert.equal(shown.vertices, native.vertices, `Fresh source vs displayed ${stage} #${native.id} vertex count`);
                for (let axis=0;axis<3;axis++) for (const edge of ['min','max']) assert.ok(Math.abs(native[edge][axis]-shown[edge][axis]) < 1e-4, `Fresh source vs displayed ${stage} #${native.id} ${edge}/${axis}`);
              }
              break;
            } catch (error) {
              if ((!String(error).includes('Missing displayed mesh') && !String(error).includes('Fresh source vs displayed')) || Date.now() >= deadline) throw error;
              await settle();
            }
          }
          proofs.push({ stage, models });
          await page.screenshot({ path: path.join(dir, `${count}-${stage}.png`) });
          fs.writeFileSync(path.join(dir, `${count}-progress.json`), JSON.stringify({ count, modelId, source, proofs, calls }));
          return target;
        };
        const undo = async () => { await page.keyboard.press('Control+z'); await settle(); };
        const sameGraphGeometry = (actual, expected) => {
          assert.deepEqual(actual.canonicalGraph ?? actual.graph, expected.canonicalGraph ?? expected.graph, 'Undo restores persistent EXPRESS graph and complete typed exported metadata; only synthetic export identities are normalized');
          assert.deepEqual(actual.meshes, expected.meshes, 'Undo restores actual owning-model geometry incl origins');
          assert.equal(actual.undo, expected.undo, 'one Undo restores the prior recorded history head');
        };
        await capture('baseline', [1222]);
        await exercise({ page, modelId, count, baseline: baseline.find(model=>model.modelId===modelId), send, capture, undo, sameGraphGeometry });
        await Promise.all(networkTasks);
        assert.ok(wasmResponses.some(response => response.sha256 === source.wasmSHA256), 'Capture must observe actual final WASM bytes loaded by Chrome');
        assert.ok(!logs.some(line => line.startsWith('PAGEERROR') || line.includes('LOAD_FAILURE') || line.includes('WASM_RECEIPT_ERROR')), 'Runtime/load errors do not qualify mutation evidence');
        assert.deepEqual(sourceReceipt(), source, 'Source/WASM must not change during capture');
        fs.writeFileSync(path.join(dir, `${count}-browser.json`), JSON.stringify({ count, modelId, source, userAgent: await page.evaluate(()=>navigator.userAgent), wasmResponses, proofs, calls }));
        fs.writeFileSync(path.join(dir, `${count}-console.log`), logs.join('\n'));
        console.log(`PASS ${name} ${count} models`);
      } finally {
        fs.writeFileSync(path.join(dir, `${count}-console.log`), logs.join('\n'));
        fs.writeFileSync(path.join(dir, `${count}-wasm.json`), JSON.stringify(wasmResponses));
        if (!page.isClosed()) fs.writeFileSync(path.join(dir, `${count}-remesh.json`), JSON.stringify(await page.evaluate(() => globalThis.parityRemesh)));
        if (!page.isClosed()) await page.evaluate(() => {
          globalThis.parityNativeProcessor?.dispose();
          globalThis.parityTransport?.close();
        });
        await context.close();
      }
    }
  } finally { await browser.close(); }
}
module.exports = { runSuite, assert };
