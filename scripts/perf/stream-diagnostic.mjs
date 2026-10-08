// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// #6516: run beside a project's package.json to measure its ACTUAL installed
// geometry + WASM pair. Never uploads the model or prints its path/coordinates.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Session } from 'node:inspector';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { isMainEntry } from '../lib/is-main-entry.mjs';

/** Self-time attribution only; inclusive stack totals double-count samples. */
export function profileSummary(profile) {
  const counts = new Map();
  const frames = new Map(profile.nodes.map(node => [node.id, node.callFrame]));
  let instrumentationUs = 0;
  for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
    const frame = frames.get(profile.samples[i]);
    const us = profile.timeDeltas?.[i] ?? 0;
    // Profiler.start/stop can themselves take measurable sampled time.
    if (frame?.url === import.meta.url || frame?.url === 'node:inspector') {
      instrumentationUs += us;
      continue;
    }
    const name = frame?.functionName ?? '';
    const label = /^(?:wasm-function\[\d+\]|\((?:idle|garbage collector|program|root)\))$/.test(name)
      ? name : 'JavaScript/other';
    const wasm = frame?.url?.startsWith('wasm://') ?? false;
    const key = JSON.stringify({ label, wasm, functionOffset: wasm ? frame.columnNumber : undefined });
    // The same function at multiple call-tree positions is one self-time row.
    counts.set(key, (counts.get(key) ?? 0) + us);
  }
  const totalUs = [...counts.values()].reduce((a, b) => a + b, 0);
  return {
    sampledMs: totalUs / 1000,
    instrumentationMs: instrumentationUs / 1000,
    // Package paths can identify a client/project. The key retains only WASM
    // numeric labels/offsets or inspector's idle/GC labels.
    hottest: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([key, us]) => ({ ...JSON.parse(key), selfMs: us / 1000, percent: totalUs ? 100 * us / totalUs : 0 })),
  };
}

async function versionAt(entry, expectedName) {
  let directory = dirname(entry);
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (pkg.name === expectedName) return pkg.version;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate ${expectedName} package metadata`);
    directory = parent;
  }
}

/** A separate untimed pass checks byte identity without hashing in the timer.
 * Sort per-mesh hashes so changing streaming batches/order alone is harmless.
 * A changed digest means byte output differs, not necessarily wrong geometry. */
async function outputDigest(GeometryProcessor, bytes) {
  const processor = new GeometryProcessor();
  const hashes = [];
  try {
    await processor.init();
    for await (const event of processor.processStreaming(bytes)) {
      if (event.type !== 'batch') continue;
      for (const mesh of event.meshes) {
        const hash = createHash('sha256');
        hash.update(JSON.stringify([mesh.expressId, mesh.origin ?? null, mesh.color]));
        for (const key of ['positions', 'normals', 'indices']) {
          const array = mesh[key];
          hash.update(JSON.stringify([key, array.constructor.name, array.byteLength]));
          hash.update(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
        }
        hashes.push(hash.digest('hex'));
      }
    }
  } finally {
    processor.dispose?.();
  }
  return createHash('sha256').update(hashes.sort().join('\n')).digest('hex');
}

export async function diagnose(modelPath, { cwd = process.cwd(), profile = false } = {}) {
  const require = createRequire(join(resolve(cwd), 'package.json'));
  const geometryEntry = require.resolve('@ifc-lite/geometry');
  // Mirror the Node loader's resolution from geometry, rather than reporting
  // an unrelated directly installed WASM version in the host project.
  const wasmEntry = createRequire(geometryEntry).resolve('@ifc-lite/wasm/ifc-lite_bg.wasm');
  const { GeometryProcessor } = await import(pathToFileURL(geometryEntry).href);
  const bytes = new Uint8Array(await readFile(modelPath));
  const processor = new GeometryProcessor();
  const inspector = profile ? new Session() : null;
  const post = (method) => new Promise((fulfil, reject) => inspector.post(method, (error, result) => error ? reject(error) : fulfil(result)));
  let cpu;
  let meshes = 0;
  let triangles = 0;
  let elapsedMs;
  const batchWaitMs = [];
  try {
    await processor.init();
    if (inspector) { inspector.connect(); await post('Profiler.enable'); await post('Profiler.start'); }
    const start = performance.now();
    const iterator = processor.processStreaming(bytes);
    try {
      for (;;) {
        const before = performance.now();
        const next = await iterator.next();
        const waited = performance.now() - before;
        if (next.done) break;
        if (next.value.type === 'batch') {
          batchWaitMs.push(waited);
          meshes += next.value.meshes.length;
          for (const mesh of next.value.meshes) triangles += mesh.indices.length / 3;
        }
      }
    } finally { await iterator.return(); }
    elapsedMs = performance.now() - start;
    if (inspector) cpu = (await post('Profiler.stop')).profile;
  } finally {
    inspector?.disconnect();
    processor.dispose?.();
  }
  return {
    schemaVersion: 1,
    node: process.version,
    geometry: await versionAt(geometryEntry, '@ifc-lite/geometry'),
    wasm: await versionAt(wasmEntry, '@ifc-lite/wasm'),
    wasmSha256: createHash('sha256').update(await readFile(wasmEntry)).digest('hex'),
    fileBytes: bytes.byteLength,
    profiled: profile,
    elapsedMs, meshes, triangles,
    batchWaitMs,
    meshBytesSha256: await outputDigest(GeometryProcessor, bytes),
    ...(cpu ? { cpu: profileSummary(cpu) } : {}),
  };
}

if (isMainEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const profile = args.includes('--profile');
  const positional = args.filter(arg => arg !== '--profile');
  if (positional.length !== 1) throw new Error('Usage: node stream-diagnostic.mjs <model.ifc> [--profile] (run from the project with installed packages)');
  // Library diagnostics can contain client-supplied metadata. Keep the CLI's
  // shareable stdout limited to this report, including on failure.
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const original = Object.fromEntries(methods.map(name => [name, console[name]]));
  const libraryLogLines = Object.fromEntries(methods.map(name => [name, 0]));
  let report;
  let failed = false;
  try {
    for (const name of methods) console[name] = () => { libraryLogLines[name]++; };
    report = await diagnose(positional[0], { profile });
  } catch {
    // Report below after restoring console; do not expose private error text.
    failed = true;
  } finally {
    for (const name of methods) console[name] = original[name];
  }
  if (failed) {
    console.error('Streaming diagnostic failed; model-specific error text was withheld.');
    process.exitCode = 1;
  } else console.log(JSON.stringify({ ...report, libraryLogLines }, null, 2));
}
