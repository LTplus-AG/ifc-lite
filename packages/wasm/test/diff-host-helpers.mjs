/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function engine(context) {
  const binary = new URL('../pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
  if (!existsSync(binary)) {
    context.skip('WASM bundle missing; run pnpm build:wasm');
    return;
  }
  const wasm = await import('../pkg-diff/ifc-lite-diff.js');
  wasm.initSync({ module: readFileSync(binary) });
  return wasm;
}

// Independent oracle: production TS built from main 97d8add20710, before the
// public facade cutover. packages/diff now is the facade, so it can never stand
// in for this: run the parity checks only against an explicitly supplied build.
export async function currentMainOracle(context) {
  const path = process.env.IFC_LITE_CURRENT_MAIN_DIFF_ORACLE;
  if (!path) {
    context.skip('TS production oracle missing; independently build main 97d8add20710 and set IFC_LITE_CURRENT_MAIN_DIFF_ORACLE to its dist/index.js');
    return;
  }
  const url = pathToFileURL(path);
  // An explicitly requested oracle that is absent is a broken CI setup, not
  // optional coverage: skipping would report the parity checks as passing.
  if (!existsSync(url)) throw new Error(`IFC_LITE_CURRENT_MAIN_DIFF_ORACLE is set but does not exist: ${path}`);
  const resolved = realpathSync(url);
  context.diagnostic(JSON.stringify({
    oracle: 'current-main-production-TS', selection: 'environment',
    requested: path, resolved,
    entrySha256: createHash('sha256').update(readFileSync(resolved)).digest('hex'),
    expectedSourceCommit: '97d8add207104d5801c0c8d62e40fa7066e848f8',
  }));
  const api = await import(pathToFileURL(resolved).href);
  assert.equal(api.initDiff, undefined, 'the oracle must be independent TS production, from before the facade cutover');
  for (const name of ['createIdentityMapSidecar', 'createLineageSidecar', 'validateLineageSidecar', 'rekeyByLineage']) {
    assert.equal(typeof api[name], 'function', name);
  }
  return api;
}

export function init(entries) {
  return { base: { hash: 'old' }, head: { hash: 'new' }, entries };
}
export function create(api, value, lineage) {
  return lineage ? api.createLineageSidecar(value) : api.createIdentityMapSidecar(value);
}
export function split(shares, head = ['a', 'b']) {
  return { base: ['source'], head, relation: 'split', reason: 'split:verified', shares };
}
export function rekey(wasm, entry, keys = ['source'], policy = 'largest-share') {
  return wasm.diffRekeyByLineage(keys, [entry], [], policy);
}
export function row(successors) {
  return [{ key: 'source', successors, relation: 'split', orphan: successors.length === 0 }];
}

// Each run gets fresh live inputs; callers restore intrinsic mutations even
// when an assertion/host callback throws. Compare thrown sentinels explicitly.
export function observe(make, run) {
  const trace = [];
  const input = make(trace);
  try {
    return { value: run(input), trace };
  } catch (error) {
    return { error, trace };
  } finally {
    input.restore?.();
  }
}
export function sameObservation(expected, actual) {
  assert.deepEqual(actual.trace, expected.trace);
  if ('error' in expected) {
    assert.ok('error' in actual, 'expected a thrown value');
    assert.equal(actual.error, expected.error, 'thrown value identity');
  }
  else {
    if ('error' in actual) throw actual.error;
    assert.deepEqual(actual.value, expected.value);
  }
}
