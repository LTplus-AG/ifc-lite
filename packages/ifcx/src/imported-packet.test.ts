/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importedGeometryBytes } from './generated/imported-geometry.js';
import { runImportedPacket } from './imported-kernel.js';

interface WasmKernel {
  memory: WebAssembly.Memory;
  imported_alloc(n: number): number;
  imported_free(p: number, n: number): void;
  imported_run(p: number, n: number): number;
}
function executeWasm(kernel: WasmKernel, input: Uint8Array): Uint8Array {
  const p = kernel.imported_alloc(input.length) >>> 0;
  let result = 0; let length = 0;
  try {
    new Uint8Array(kernel.memory.buffer, p, input.length).set(input);
    result = kernel.imported_run(p, input.length) >>> 0;
    length = new DataView(kernel.memory.buffer).getUint32(result, true);
    return new Uint8Array(kernel.memory.buffer, result, length).slice();
  } finally {
    kernel.imported_free(p, input.length);
    if (result) kernel.imported_free(result, length);
  }
}
function stagePacket(values: readonly number[]): Uint8Array {
  const input = new Uint8Array(12 + values.length * 8);
  const view = new DataView(input.buffer);
  view.setUint32(0, 1, true); view.setUint32(4, 4, true); view.setUint32(8, values.length, true);
  values.forEach((v, i) => view.setFloat64(12 + i * 8, v, true));
  return input;
}

test('same Rust wasm and static translation preserve typed packet fields across float boundaries and memory growth', () => {
  const module = new WebAssembly.Module(importedGeometryBytes());
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  const wasm = new WebAssembly.Instance(module).exports as unknown as WasmKernel;
  const values = [0, -0, NaN, Infinity, -Infinity, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE,
    2 ** -149, -(2 ** -149), 1 + 2 ** -24, 1 + 3 * 2 ** -24, 16777217, -16777217];
  let seed = 42;
  for (let i = 0; i < 2000; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    values.push((seed / 2 ** 32 - 0.5) * 2 ** (i % 250 - 125));
  }
  const packet = stagePacket(values);
  assert.deepEqual(runImportedPacket(packet), executeWasm(wasm, packet));
  const grown = stagePacket(Array(160000).fill(1 + 2 ** -24));
  assert.deepEqual(runImportedPacket(grown), executeWasm(wasm, grown));
  // A second small request checks the allocator after both memories grew.
  assert.deepEqual(runImportedPacket(packet), executeWasm(wasm, packet));
});

test('static and wasm report the same malformed packet error without trapping', () => {
  const wasm = new WebAssembly.Instance(new WebAssembly.Module(importedGeometryBytes())).exports as unknown as WasmKernel;
  for (const input of [new Uint8Array(), new Uint8Array([1, 0, 0, 0]), stagePacket([1]).slice(0, -1)]) {
    const out = executeWasm(wasm, input);
    assert.equal(new DataView(out.buffer).getUint32(4, true), 1);
    const error = new TextDecoder().decode(out.subarray(8));
    assert.throws(() => runImportedPacket(input), { message: error });
  }
});
