/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Plain Node process: the real recursive oracle must not inherit Vitest's
// transform/worker stack overhead (#8042). No stack flags or replacement oracle.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const entry = new URL('../dist/index.js', import.meta.url);
const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
const glue = new URL('../../wasm/pkg-diff/ifc-lite-diff.js', import.meta.url);
for (const artifact of [entry, binary, glue]) {
  assert.ok(existsSync(artifact), `Missing ${artifact.pathname}; run pnpm build from the repository root before pnpm test.`);
}
const facade = await import(entry.href);
// Only the private TypeScript oracle uses tsx; the public facade is built JS.
const { tsImport } = await import('tsx/esm/api');
const oracle = await tsImport('./oracle/fingerprint.ts', import.meta.url);
facade.initDiffSync({ module: readFileSync(binary) });

const graph = (depth, kind) => {
  let value = 'leaf';
  for (let level = 0; level < depth; level++) {
    value = kind === 'array' || (kind === 'mixed' && level % 2 === 0) ? [value] : { x: value };
  }
  return value;
};
const summary = {
  protocol: 'wasm-fingerprint-deep-v1', caseIds: [], caseCount: 0,
  finiteCaseCount: 0, cycleCaseCount: 0, recoveryCaseCount: 0, retainedCaseCount: 0,
  finiteWarningCount: 0, recoveryWarningCount: 0, retainedCallbackWarningCount: 0,
  fallbackWarningCount: 0, normalizeCallCount: 0, retainedCallbackCount: 0,
};
const complete = (id, countKey) => {
  summary.caseIds.push(id);
  summary.caseCount++;
  summary[countKey]++;
};
const warnings = [];
const originalWarn = console.warn;
const warningMessage = '[diff] normalizeValue: non-serializable value, using String() fallback:';
const normalize = (implementation, value) => {
  summary.normalizeCallCount++;
  return implementation.normalizeValue(value);
};
const noWarnings = (countKey, label) => {
  summary[countKey] += warnings.length;
  assert.equal(warnings.length, 0, `${label}: unexpected normalization warning`);
};
const fallbackWarning = (label, sentinel) => {
  assert.equal(warnings.length, 1, `${label}: exactly one fallback warning`);
  assert.equal(warnings[0].length, 2, label);
  assert.equal(warnings[0][0], warningMessage, label);
  if (sentinel !== undefined) assert.equal(warnings[0][1], sentinel, `${label}: exception identity`);
  summary.fallbackWarningCount++;
};

console.warn = (...args) => { warnings.push(args); };
try {
  for (const depth of [512, 1024, 2048]) {
    for (const kind of ['array', 'object', 'mixed']) {
      const id = `finite:${depth}:${kind}`;
      const value = graph(depth, kind);
      warnings.length = 0;
      const expected = normalize(oracle, value);
      noWarnings('finiteWarningCount', `${id}: oracle`);
      assert.equal(normalize(facade, value), expected, `${id}: Rust output`);
      noWarnings('finiteWarningCount', `${id}: Rust`);
      complete(id, 'finiteCaseCount');
    }
  }
  const objectCycle = {}; objectCycle.self = objectCycle;
  const arrayCycle = []; arrayCycle.push(arrayCycle);
  for (const [kind, value, fallback] of [
    ['object', objectCycle, '[object Object]'], ['array', arrayCycle, ''],
  ]) {
    const id = `cycle:${kind}`;
    warnings.length = 0;
    const expected = normalize(oracle, value);
    assert.equal(expected, fallback, `${id}: oracle fallback`);
    fallbackWarning(`${id}: oracle`);
    warnings.length = 0;
    assert.equal(normalize(facade, value), expected, `${id}: Rust fallback`);
    fallbackWarning(`${id}: Rust`);
    complete(id, 'cycleCaseCount');
    warnings.length = 0;
    // Use the same WASM instance after each cycle, at the original depth.
    const next = graph(2048, 'mixed');
    const actual = normalize(facade, next);
    noWarnings('recoveryWarningCount', `${id}: Rust recovery`);
    assert.equal(actual, normalize(oracle, next), `${id}: recovery output`);
    noWarnings('recoveryWarningCount', `${id}: oracle recovery`);
    complete(`recovery:${kind}:2048:mixed`, 'recoveryCaseCount');
  }
  for (const fail of [false, true]) {
    const id = `retained:${fail ? 'throw' : 'success'}:2048:mixed`;
    const observe = (implementation, label) => {
      let callback;
      const sentinel = { failure: 'retain deep visitor' };
      const input = [1];
      Object.defineProperty(input, 'map', { value(visitor) {
        callback = visitor;
        if (fail) throw sentinel;
        return ['first'];
      } });
      warnings.length = 0;
      const first = normalize(implementation, input);
      assert.equal(first, fail ? '1' : '[first]', `${id}: ${label} first output`);
      if (fail) fallbackWarning(`${id}: ${label}`, sentinel);
      else noWarnings('retainedCallbackWarningCount', `${id}: ${label} first`);
      assert.equal(typeof callback, 'function', `${id}: ${label} retained visitor`);
      warnings.length = 0;
      summary.retainedCallbackCount++;
      const later = callback(graph(2048, 'mixed'));
      noWarnings('retainedCallbackWarningCount', `${id}: ${label} later`);
      return { first, later };
    };
    assert.deepEqual(observe(facade, 'Rust'), observe(oracle, 'oracle'), id);
    complete(id, 'retainedCaseCount');
  }
} finally {
  console.warn = originalWarn;
}
// Only successful, complete execution emits a bounded protocol response.
process.stdout.write(`${JSON.stringify(summary)}\n`);
