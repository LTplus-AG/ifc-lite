/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { test } from 'node:test';
import type { WorkerResult } from '../src/messages.mjs';

const repo = new URL('../../../', import.meta.url);
const fixture = fileURLToPath(new URL('tests/models/ara3d/AC20-FZK-Haus.ifc', repo));
const skip = existsSync(fixture) ? false : 'Run pnpm fixtures to fetch the independently authored FZK fixture';
const run = (script: string, args: string[]) => spawnSync(process.execPath, [
  fileURLToPath(new URL(`../dist/${script}.mjs`, import.meta.url)), ...args,
], { encoding: 'utf8', timeout: 60000 });

test('the edit recipe preserves identity and its property after reopening (DX4)', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ifclite-headless-edit-'));
  try {
    const output = join(dir, 'edited.ifc');
    const result = run('edit', [fixture, output]);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout) as { GlobalId: string };
    const { withModelFile } = await import('../src/common.mjs');
    await withModelFile(output, model => {
      const doors = model.bim.query().byType('IfcDoor').toArray();
      assert.equal(doors.length, 5);
      const target = doors.find(door => door.globalId === receipt.GlobalId);
      assert.ok(target);
      assert.equal(model.bim.property(target.ref, 'DX_Example', 'Checked'), true);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const hasRuntime = existsSync(new URL('packages/wasm/pkg/ifc-lite_bg.wasm', repo));
test('the geometry recipe refuses incomplete record coverage before export (PR #7641)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ifclite-headless-incomplete-'));
  try {
    const source = readFileSync(new URL('apps/viewer/public/samples/hello-wall.ifc', repo), 'utf8');
    // Keep the real wall and complete envelope, but add an id outside the scan's
    // uint32 domain. A successful partial scan must not become a whole-model GLB.
    const end = source.lastIndexOf('ENDSEC;');
    assert.ok(end > 0);
    const input = join(dir, 'incomplete.ifc');
    const output = join(dir, 'partial.glb');
    writeFileSync(input, source.slice(0, end) + "#4294967296=IFCWALL('0000000000000000000002',$,'lost',$,$,$,$,$,$);\n" + source.slice(end));
    const result = run('geometry', [input, output]);
    assert.notEqual(result.status, 0, result.stderr);
    // @source-text-assertion-ok this is the recipe process's runtime refusal, not source text
    assert.match(result.stderr, /Record coverage is incomplete or unknown/);
    assert.equal(existsSync(output), false);
    assert.equal(result.stdout, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the geometry recipe writes a GLB compatibility envelope (DX4)', {
  skip: skip || (!hasRuntime ? 'Build WASM or run pnpm build:wasm:fetch' : false),
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ifclite-headless-geometry-'));
  try {
    const output = join(dir, 'model.glb');
    const result = run('geometry', [fixture, output]);
    assert.equal(result.status, 0, result.stderr);
    const glb = readFileSync(output);
    assert.equal(glb.subarray(0, 4).toString('ascii'), 'glTF');
    assert.equal(glb.readUInt32LE(4), 2);
    assert.equal(glb.readUInt32LE(8), glb.byteLength);
    const receipt = JSON.parse(result.stdout) as { meshes: number; report: { completeness: string } };
    assert.ok(receipt.meshes > 0);
    assert.equal(receipt.report.completeness, 'complete');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('aborting the worker client retires a thread blocked in synchronous work (DX4)', { skip }, async () => {
  const { queryDoors } = await import('../src/worker-client.mjs');
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let owned: Worker | undefined;
  let active = 0;
  const pending = queryDoors(readFileSync(fixture), controller.signal, delta => { active += delta; }, input => {
    owned = new Worker(new URL('./blocked-worker.mjs', import.meta.url), { workerData: input, transferList: [input] });
    owned.once('message', started);
    return owned;
  });
  try {
    await Promise.race([ready, pending.then(() => { throw new Error('Worker completed before cancellation'); })]);
    controller.abort(new DOMException('Test cancelled', 'AbortError'));
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(owned?.threadId, -1);
    assert.equal(active, 0);
  } finally {
    controller.abort();
    await owned?.terminate();
  }
});

test('the local HTTP recipe queries through an owned worker (DX4)', { skip }, async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/server.mjs', import.meta.url))], {
    env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const errors: string[] = [];
  child.stderr.on('data', chunk => errors.push(String(chunk)));
  try {
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${errors.join('')}`)), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited (${code}): ${errors.join('')}`)); });
    child.stdout.on('data', chunk => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
    const response = await fetch(`${url}/doors`, { method: 'POST', body: Uint8Array.from(readFileSync(fixture)).buffer });
    assert.equal(response.status, 200, errors.join(''));
    const result = await response.json() as WorkerResult;
    if (!result.ok) assert.fail(result.message);
    assert.equal(result.doors.length, 5);
    const health = await fetch(`${url}/health`).then(response => response.json()) as { activeRequests: number; activeWorkers: number };
    assert.deepEqual(health, { activeRequests: 0, activeWorkers: 0 });
    const invalid = await fetch(`${url}/doors`, { method: 'POST', body: 'not an IFC file' });
    assert.equal(invalid.status, 400);
    const oversized = await fetch(`${url}/doors`, { method: 'POST', body: new Uint8Array(16 * 1024 * 1024 + 1) });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await fetch(`${url}/health`).then(response => response.json()), { activeRequests: 0, activeWorkers: 0 });
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); });
  }
});
