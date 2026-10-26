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

// Staging oracle: independently built production TS from main 97d8add20710.
// At the host-only layer the local public graph still has those algorithms.
// At public cutover supply the independent build explicitly, never the facade
// or the historical R124 private oracle. No implementation is copied here.
export async function currentMainOracle(context) {
  const path = process.env.IFC_LITE_CURRENT_MAIN_DIFF_ORACLE;
  const url = path ? pathToFileURL(path) : new URL('../../diff/dist/index.js', import.meta.url);
  if (!existsSync(url)) {
    context.skip('TS production oracle missing; independently build main 97d8add20710 and set IFC_LITE_CURRENT_MAIN_DIFF_ORACLE to its dist/index.js');
    return;
  }
  const resolved = realpathSync(url);
  context.diagnostic(JSON.stringify({
    oracle: 'current-main-production-TS', selection: path ? 'environment' : 'local-staging',
    requested: path ?? url.href, resolved,
    entrySha256: createHash('sha256').update(readFileSync(resolved)).digest('hex'),
    expectedSourceCommit: '97d8add207104d5801c0c8d62e40fa7066e848f8',
  }));
  const api = await import(pathToFileURL(resolved).href);
  assert.equal(api.initDiff, undefined, 'staging oracle must be independent TS production, before facade cutover');
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
