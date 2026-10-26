/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import * as identityOracle from '../test/oracle/identity-sidecar.js';
import * as lineageOracle from '../test/oracle/lineage-sidecar.js';
import type { IdentityMapSidecar, IdentityMapSidecarInit } from './identity-sidecar.js';
import type { LineageSidecar, LineageSidecarInit } from './lineage-sidecar.js';

const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
const available = existsSync(binary) && existsSync(new URL('../../wasm/pkg-diff/ifc-lite-diff.js', import.meta.url));
const wasmTest = test.skipIf(!available);
async function adapters() {
  const { initDiffSync } = await import('./wasm-runtime.js');
  initDiffSync({ module: readFileSync(binary) });
  return { identity: await import('./wasm-identity-sidecar.js'), lineage: await import('./wasm-lineage-sidecar.js') };
}
function identityInit(): IdentityMapSidecarInit {
  return { base: { hash: 'sha256:old' }, head: { hash: 'sha256:new' }, entries: [
    { base: 'z', here: 'Z', reason: 'z' }, { base: 'a', here: 'A', reason: 'first' },
    { base: 'a', here: 'A', reason: 'duplicate discarded' },
  ] };
}
function lineageInit(): LineageSidecarInit {
  return { base: { hash: 'old' }, head: { hash: 'new' }, entries: [
    { base: ['z'], head: ['Z'], relation: 'identity', reason: 'z' },
    { base: ['a'], head: ['A','B'], relation: 'split', reason: 'a', shares: [0.3,0.7] },
  ], deleted: ['gone','gone','other'] };
}
function outcome(run: () => unknown): unknown {
  try { return { value: run() }; } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return { error: (error as Error).name, message: (error as Error).message };
  }
}
wasmTest('all public sidecar operations compare against the TS oracle through actual WASM (#8042)', async () => {
  const { identity, lineage } = await adapters();
  const i = identity.createIdentityMapSidecar(identityInit());
  expect(i).toEqual(identityOracle.createIdentityMapSidecar(identityInit()));
  expect(identity.validateIdentityMapSidecar(i)).toEqual(identityOracle.validateIdentityMapSidecar(i));
  expect(identity.serializeIdentityMapSidecar(i)).toBe(identityOracle.serializeIdentityMapSidecar(i));
  expect(identity.parseIdentityMapSidecar(identity.serializeIdentityMapSidecar(i))).toEqual(i);
  expect([...identity.keyAliasesFromSidecar(i)]).toEqual([...identityOracle.keyAliasesFromSidecar(i)]);
  const models = { base: { hash: 'different' }, head: { hash: 'also different' }, keyProperty: 'Tag' };
  expect(identity.identityMapSidecarMismatches(i,models)).toEqual(identityOracle.identityMapSidecarMismatches(i,models));
  const l = lineage.createLineageSidecar(lineageInit());
  expect(l).toEqual(lineageOracle.createLineageSidecar(lineageInit()));
  expect(lineage.validateLineageSidecar(l)).toEqual(lineageOracle.validateLineageSidecar(l));
  expect(lineage.serializeLineageSidecar(l)).toBe(lineageOracle.serializeLineageSidecar(l));
  expect(lineage.parseLineageSidecar(lineage.serializeLineageSidecar(l))).toEqual(l);
  expect(lineage.lineageSidecarMismatches(l,models)).toEqual(lineageOracle.lineageSidecarMismatches(l,models));
});
wasmTest('validators ignore cyclic/BigInt/function/toJSON extras and retain inherited fields (#8042)', async () => {
  const { identity, lineage } = await adapters();
  for (const [valid, validate, oracle] of [
    [identityOracle.createIdentityMapSidecar(identityInit()),identity.validateIdentityMapSidecar,identityOracle.validateIdentityMapSidecar],
    [lineageOracle.createLineageSidecar(lineageInit()),lineage.validateLineageSidecar,lineageOracle.validateLineageSidecar],
  ] as const) {
    const value: Record<string, unknown> = Object.create(valid);
    value.cycle = value; value.big = 1n; value.fn = () => undefined; value.symbol = Symbol('ignored');
    Object.defineProperty(value,'ignored',{ get() { throw new Error('must never inspect ignored extras'); } });
    value.toJSON = () => { throw new Error('must never stringify a validator input'); };
    expect(validate(value)).toEqual(oracle(value));
    expect(validate(value)).toEqual([]);
    for (const input of [undefined, null, 1n, Symbol(), () => undefined, [], true, 'text']) {
      expect(validate(input)).toEqual(oracle(input));
    }
  }
});
wasmTest('unknown validators retain malformed-entry order, undefined values and sparse array behavior (#8042)', async () => {
  const { identity, lineage } = await adapters();
  const invalids: unknown[] = [undefined, null, () => undefined, Symbol('field'), 1n, 0, false, [], {}];
  const i = identityOracle.createIdentityMapSidecar(identityInit());
  const l = lineageOracle.createLineageSidecar(lineageInit());
  for (const field of ['format','version','base','head','created','keyProperty','entries']) {
    for (const value of invalids) {
      const input = { ...i, [field]: value };
      expect(outcome(() => identity.validateIdentityMapSidecar(input))).toEqual(outcome(() => identityOracle.validateIdentityMapSidecar(input)));
    }
  }
  for (const field of ['format','version','base','head','created','keyProperty','entries','deleted']) {
    for (const value of invalids) {
      const input = { ...l, [field]: value };
      expect(outcome(() => lineage.validateLineageSidecar(input))).toEqual(outcome(() => lineageOracle.validateLineageSidecar(input)));
    }
  }
  const entry = { base: ['a'], head: ['A'], relation: 'identity', reason: '' };
  for (const entries of [new Array(2), [{},entry], [entry,{}], [{...entry,base:new Array(1)}], [{...entry,shares:new Array(1)}], [{...entry,head:['A','B'],relation:'split',shares:new Array(2)}]]) {
    const input = { ...l, entries };
    expect(outcome(() => lineage.validateLineageSidecar(input))).toEqual(outcome(() => lineageOracle.validateLineageSidecar(input)));
  }
  expect(identity.validateIdentityMapSidecar({ ...i, entries: new Array(1) })).toEqual(identityOracle.validateIdentityMapSidecar({ ...i, entries: new Array(1) }));
});
wasmTest('host JSON.parse keeps original syntax errors, ignored full-depth extras and raw lone units (#8042)', async () => {
  const { identity, lineage } = await adapters();
  for (const [valid, parse, oracle] of [
    [identityOracle.createIdentityMapSidecar(identityInit()),identity.parseIdentityMapSidecar,identityOracle.parseIdentityMapSidecar],
    [lineageOracle.createLineageSidecar(lineageInit()),lineage.parseLineageSidecar,lineageOracle.parseLineageSidecar],
  ] as const) {
    for (const text of ['', '{', '{"x":}', '[1,]', 'null', '1', '"string"']) expect(outcome(() => parse(text))).toEqual(outcome(() => oracle(text)));
    const deep = '['.repeat(1000) + '0' + ']'.repeat(1000);
    const text = JSON.stringify(valid).slice(0,-1) + ',"extra":' + deep + ',"raw":"\ud800","escaped":"\\udfff"}';
    const actual = parse(text) as unknown as Record<string, unknown>;
    expect(actual).toEqual(oracle(text));
    expect((actual.raw as string).charCodeAt(0)).toBe(0xd800);
    expect((actual.escaped as string).charCodeAt(0)).toBe(0xdfff);
  }
});
wasmTest('serialization is exactly host JSON.stringify including unsupported values, toJSON and errors (#8042)', async () => {
  const { identity, lineage } = await adapters();
  for (const [serialize, oracle] of [
    [identity.serializeIdentityMapSidecar,identityOracle.serializeIdentityMapSidecar],
    [lineage.serializeLineageSidecar,lineageOracle.serializeLineageSidecar],
  ] as const) {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const sparse = [undefined, () => 0, Symbol(), undefined, NaN, Infinity];
    delete sparse[3]; // Exercise a real sparse slot without a sparse-array literal.
    for (const value of [undefined, null, () => 1, Symbol(), {x:undefined,f:()=>0,s:Symbol()}, sparse, {toJSON:()=>({raw:'\ud800',z:1})}, cyclic, {big:1n}]) {
      // Both signatures intentionally reject these at compile time; runtime
      // behavior remains the existing public serializer's host JSON contract.
      expect(outcome(() => serialize(value as IdentityMapSidecar & LineageSidecar))).toEqual(outcome(() => oracle(value as IdentityMapSidecar & LineageSidecar)));
    }
  }
});
wasmTest('creation retains UTF-16 sort/dedup, diagnostics, field projection and #8088 separator collisions (#8042)', async () => {
  const { identity, lineage } = await adapters();
  const extras = { ignored: 1n, toJSON() { throw new Error('ignored toJSON'); } };
  const entries = [
    {base:'\ue000',here:'E',reason:'bmp'}, {base:'\ud800',here:'lone',reason:'raw'},
    {base:'\ud800\udc00',here:'astral',reason:'astral'},
    {base:'a\0b',here:'c',reason:'first'}, {base:'a',here:'b\0c',reason:'collision'},
  ];
  const init = { ...identityInit(), ...extras, entries: entries.map(e=>Object.assign(Object.create(e),extras)) };
  const actual = identity.createIdentityMapSidecar(init);
  expect(actual).toEqual(identityOracle.createIdentityMapSidecar(init));
  expect(identity.serializeIdentityMapSidecar(actual)).toBe(identityOracle.serializeIdentityMapSidecar(identityOracle.createIdentityMapSidecar(init)));
  const conflict = {...identityInit(),entries:[{base:'a',here:'\ud800',reason:''},{base:'b',here:'\ud800',reason:''}]};
  expect(outcome(() => identity.createIdentityMapSidecar(conflict))).toEqual(outcome(() => identityOracle.createIdentityMapSidecar(conflict)));
  const l = {...lineageInit(), ...extras, entries:[
    {base:['a\u0001b'],head:['C'],relation:'merge' as const,reason:'first'},
    {base:['a','b'],head:['C'],relation:'merge' as const,reason:'collision'},
  ]};
  expect(lineage.createLineageSidecar(l)).toEqual(lineageOracle.createLineageSidecar(l));
  for (const created of ['2026-10-24', 'January 1, 2000', 'no date', '\ud800']) {
    const input = {...identityInit(),created};
    expect(outcome(() => identity.createIdentityMapSidecar(input))).toEqual(outcome(() => identityOracle.createIdentityMapSidecar(input)));
  }
  const aliasInput = {...actual,entries:[{base:'b',here:'x',reason:''},{base:'x',here:'x',reason:''},{base:'z',here:'z',reason:''},{base:'a',here:'\ud800',reason:''}]};
  expect([...identity.keyAliasesFromSidecar(aliasInput)]).toEqual([...identityOracle.keyAliasesFromSidecar(aliasInput)]);
});
