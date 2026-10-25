// SPDX-License-Identifier: MPL-2.0
// #7955: synthetic declarations test semantic closure, not repository source text.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wasmMemberSurface } from './lib/wasm-member-surface.mjs';

test('retained alias detects changed class members and rejects unresolved closure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wasm-members-'));
  const entry = join(dir, 'entry.d.ts'), engine = join(dir, 'engine.d.ts');
  try {
    writeFileSync(entry, "export type RetainedEngine = typeof import('./engine.js');\n");
    const base = `export declare class IfcAPI {
      constructor(size: number);
      static create<T extends string = string>(value: T): IfcAPI;
      readonly size: number;
      inspect(value: number): Uint8Array;
      inspect(value: string): string;
    }
    export interface InitOutput { readonly __wasm_bindgen_func_elem_123: Function; }
    `;
    writeFileSync(engine, base);
    const before = wasmMemberSurface(entry);
    assert.deepEqual(before.files, [engine, entry].sort());
    for (const [from, to] of [['size: number', 'size: string'], ['value: number', 'value: boolean'],
      ['Uint8Array', 'Uint16Array'], ['extends string', 'extends string | number'], ['= string', '= never'],
      ['static create', 'create'], ['readonly size', 'size'], ['inspect(value: string): string;', '']]) {
      writeFileSync(engine, base.replace(from, to));
      assert.notDeepEqual(wasmMemberSurface(entry).rows, before.rows, `${from} must affect reachable signatures`);
    }
    writeFileSync(engine, base.replace('_elem_123', '_elem_456'));
    assert.deepEqual(wasmMemberSurface(entry).rows, before.rows, 'Platform indices are not an API');
    writeFileSync(engine, base + "export type Missing = import('./absent.js').Missing;\n");
    assert.throws(() => wasmMemberSurface(entry), /Cannot find module/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
