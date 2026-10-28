/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Private child process entry. The cohort runner owns timeout and admission.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { LIMITS, nonempty, resultProof, handleResultProof, digest, fixtureInvariant } from './diff-e2e-protocol.mjs';

// Injecting a module loader permits behavioral lifecycle tests with tiny inert
// modules; production execution always imports the built public entry points.
export async function measure({ root, fixture, options, retained, implementation,
  mode = 'proof', optionIndex = 0 }, loadOverride) {
  assert.ok(['proof', 'cold', 'warm'].includes(mode));
  const phases = {}, memory = {};
  const phase = async (name, fn) => {
    const start = performance.now();
    try { return await fn(); }
    finally { phases[name] = (phases[name] ?? 0) + performance.now() - start; }
  };
  const snapshot = name => { memory[name] = process.memoryUsage(); };
  const load = loadOverride ?? (name => import(pathToFileURL(resolve(root, name)).href));
  let rows = [], baseHandle, headHandle;
  const dispose = () => {
    const start = performance.now();
    try {
      try { baseHandle?.dispose(); }
      finally { headHandle?.dispose(); }
    } finally {
      baseHandle = headHandle = undefined;
      phases.disposeMs = (phases.disposeMs ?? 0) + performance.now() - start;
    }
  };
  const proofs = [], retainedProofs = [], retainedTimes = [], statelessTimes = [];
  snapshot('start');
  let clockResolutionMs = Infinity, previous = performance.now();
  for (let i = 0; i < 1000; i++) {
    const now = performance.now();
    if (now > previous) clockResolutionMs = Math.min(clockResolutionMs, now - previous);
    previous = now;
  }
  assert.ok(Number.isFinite(clockResolutionMs), 'clock has no observable resolution');
  const started = performance.now();
  try {
    let parser, builder, facade;
    await phase('importsMs', async () => {
      parser = await load('packages/cli/dist/loader.js');
      builder = await load('packages/cli/dist/commands/diff-engine.js');
      facade = await load('packages/diff/dist/index.js');
    });
    await phase('initMs', async () => {
      if (implementation === 'rust-wasm') {
        // Deliberately fail on pre-cutover sources. Internal adapters are not
        // a substitute for the final production facade or its Node resolver.
        assert.equal(typeof facade.initDiff, 'function', 'final public Rust facade required');
        assert.equal(typeof facade.prepareDiffModel, 'function', 'candidate public prepareDiffModel handle API required');
        await facade.initDiff();
      } else {
        assert.equal(implementation, 'typescript');
        assert.equal(facade.initDiff, undefined, 'TS baseline must precede facade cutover');
      }
    });
    const handleApiAvailable = typeof facade.prepareDiffModel === 'function';
    const warmPath = handleApiAvailable ? 'prepared-handles' : 'stateless-diffModels';
    const callPath = mode === 'cold' ? 'stateless-diffModels' : warmPath;
    for (const path of fixture.paths) {
      const bytes = await phase('readMs', async () => {
        const info = await stat(path);
        assert.ok(info.size > 0 && info.size <= LIMITS.fixtureBytes, 'fixture byte bound');
        const input = await readFile(path);
        assert.equal(input.length, info.size, 'fixture changed during read');
        return input;
      });
      let store = await phase('parseMs', () => parser.parseIfcBytes(bytes, path));
      assert.deepEqual(parser.scanCompletenessWarnings(store), [], 'incomplete IFC scan cannot qualify');
      const fingerprints = await phase('fingerprintsMs', () => nonempty(builder.buildFileFingerprints(store)));
      rows.push(fingerprints);
      store = undefined;
    }
    snapshot('fingerprints');
    const inputHashes = mode === 'proof' ? rows.map(side => digest(side)) : undefined;
    const counts = rows.map(side => side.length);
    const indices = mode === 'proof' ? options.map((_, i) => i) : [optionIndex];
    const prepare = async () => {
      await phase('prepareHandlesMs', () => {
        baseHandle = facade.prepareDiffModel(rows[0]);
        headHandle = facade.prepareDiffModel(rows[1]);
      });
    };
    if (mode === 'warm' && handleApiAvailable) await prepare();
    const compare = i => baseHandle
      ? baseHandle.compare(headHandle, options[i])
      : facade.diffModels(rows[0], rows[1], options[i]);
    for (const i of indices) {
      let result = await phase('firstCallMs', () => compare(i));
      if (mode === 'proof') {
        fixtureInvariant(fixture, result, rows[0], rows[1]);
        proofs.push(resultProof(result, rows[0], rows[1]));
      }
      result = undefined;
    }
    snapshot('firstResultReleased');
    // Proof compares the resident path against the one-shot facade for every
    // option. Warm prepares once and conditions once, outside call latency.
    if (mode === 'proof' && handleApiAvailable) {
      await prepare();
      for (const i of indices) {
        const result = compare(i);
        assert.deepEqual(handleResultProof(result, rows[0], rows[1]), proofs[i],
          'handle conditioning differs from stateless facade');
      }
    }
    // No hash, traversal, preparation, disposal or forced GC between timed calls.
    if (mode !== 'cold') {
      for (let repeat = 0; repeat < retained; repeat++) {
        for (const i of indices) {
          const start = performance.now();
          let result = compare(i);
          const totalMs = performance.now() - start;
          retainedTimes.push({ repeat, option: i, totalMs });
          if (mode === 'proof') {
            const proof = (baseHandle ? handleResultProof : resultProof)(result, rows[0], rows[1]);
            assert.deepEqual(proof, proofs[i], 'repeated facade call changed output');
            retainedProofs.push(proof.sha256);
          }
          result = undefined;
        }
      }
    }
    if (baseHandle || headHandle) dispose();
    // Report-only secondary metric follows the primary warm observations and
    // disposal, so one-shot packing cannot condition the handle endpoint.
    if (mode === 'warm' && implementation === 'rust-wasm') {
      await phase('statelessConditioningMs', () => {
        facade.diffModels(rows[0], rows[1], options[optionIndex]);
      });
      for (let repeat = 0; repeat < retained; repeat++) {
        const start = performance.now();
        facade.diffModels(rows[0], rows[1], options[optionIndex]);
        statelessTimes.push({ repeat, option: optionIndex, totalMs: performance.now() - start });
      }
    }
    snapshot('beforeRelease');
    await phase('releaseMs', () => { rows = []; global.gc(); });
    const lifecycleTotalMs = performance.now() - started;
    snapshot('releasedAfterGc');
    return { implementation, mode, optionIndex, handleApiAvailable, callPath, warmPath, clockResolutionMs, rows: counts, inputHashes, proofs, retainedProofs,
      phases: { ...phases, lifecycleTotalMs }, retainedTimes, statelessTimes, memory,
      maxRssKiB: process.resourceUsage().maxRSS };
  } finally {
    try { if (baseHandle || headHandle) dispose(); }
    finally { rows = []; }
  }
}

if (process.send) {
  try {
    const sample = await measure(JSON.parse(process.argv[2]));
    process.send({ sample });
  } catch (error) {
    process.send({ error: error.stack ?? String(error) });
    process.exitCode = 1;
  } finally { process.disconnect(); }
}
