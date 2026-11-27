/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mainShaderSource } from './shaders/main.wgsl.js';
import { opaqueFastShaderSource } from './shaders/main-opaque-fast.wgsl.js';
import { streamShaderSource } from './shaders/main-stream.wgsl.js';
import { guardedMeshShader, unbiasedMeshShader } from './shaders/opaque-visibility.wgsl.js';
import { DEFAULT_DRAW_STREAM_CONFIG, drawStreamUsesHighlightIndex, resolveDrawStreamConfig } from './draw-stream-config.js';
import { PROXY_WORKER_SOURCE } from './draw-stream-proxy-worker.js';

describe('draw stream shader derivation', () => {
  for (const [name, base] of [['full', mainShaderSource], ['discard-free', opaqueFastShaderSource]] as const) {
    it(`derives the ${name} stream module with one fragment entry and both vertex entries`, () => {
      const s = streamShaderSource(base);
      assert.equal(s.match(/@fragment\s+fn fs_main\(/g)?.length, 1);
      assert.ok(s.includes('fn fs_main_body(input: VertexOutput)'));
      assert.ok(s.includes('fn vs_stream_quantized(') && s.includes('fn vs_stream('));
      assert.ok(s.includes('var<private> uniforms: Uniforms;') && !s.includes('var<uniform> uniforms: Uniforms;'));
    });
  }
  it('survives the orthographic visibility derivations', () => {
    const s = streamShaderSource(mainShaderSource);
    assert.ok(guardedMeshShader(s, 4).includes('geometricallyOccluded'));
    assert.ok(unbiasedMeshShader(s, 4).includes('fn fs_geometric_depth'));
  });
});

describe('draw stream config', () => {
  it('defaults every path off', () => {
    const c = resolveDrawStreamConfig();
    assert.deepEqual(c, { ...DEFAULT_DRAW_STREAM_CONFIG });
    assert.deepEqual([c.stream, c.hlod, c.arena, c.hlIndex, c.budgetMs], [false, false, false, false, 0]);
    assert.equal(drawStreamUsesHighlightIndex(c), false);
  });
  it('parses boolean and numeric spellings from flags', () => {
    const c = resolveDrawStreamConfig({ stream: '1', hlod: 'true', hlodPx: '3', bundles: '0', arena: 1, budgetMs: 16 });
    assert.deepEqual([c.stream, c.hlod, c.hlodPx, c.bundles, c.arena, c.budgetMs], [true, true, 3, false, true, 16]);
    assert.equal(drawStreamUsesHighlightIndex(c), true, 'the stream implies the highlight index');
  });
  it('keeps the base value for malformed overrides', () => {
    const c = resolveDrawStreamConfig({ stream: 'yes', hlodPx: 'abc', settleMs: -5, nodeCell: Number.NaN });
    assert.deepEqual([c.stream, c.hlodPx, c.settleMs, c.nodeCell], [false, 2, 1500, 0]);
  });
  it('layers overrides over a base config', () => {
    const base = resolveDrawStreamConfig({ stream: true, arena: true, hlod: true });
    const c = resolveDrawStreamConfig({ hlod: '0' }, base);
    assert.deepEqual([c.stream, c.arena, c.hlod], [true, true, false]);
  });
});

describe('draw stream HLOD proxy simplifier', () => {
  const run = (data: Record<string, unknown>): { pieces: { slot: number; positions: Float32Array; ids: Uint32Array }[] } => {
    let reply: unknown = null;
    const self = { postMessage: (m: unknown) => { reply = m; }, onmessage: null as null | ((e: { data: unknown }) => void) };
    new Function('self', PROXY_WORKER_SOURCE)(self);
    self.onmessage!({ data });
    return reply as { pieces: { slot: number; positions: Float32Array; ids: Uint32Array }[] };
  };
  const box = (x: number, s: number) => {
    const p: number[] = []; const idx: number[] = [];
    for (const [a, b, c] of [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]]) p.push(x + a!, b!, c!);
    idx.push(0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2);
    return { p, idx };
  };
  it('keeps a large box, drops one smaller than a cell, splits by colour slot, keeps ids', () => {
    const big = box(0, 8), small = box(20, 0.2);
    const positions = new Float32Array([...big.p, ...small.p]);
    const indices = new Uint32Array([...big.idx, ...small.idx.map((i) => i + 8)]);
    const ids = new Uint32Array([...Array(8).fill(7), ...Array(8).fill(9)]);
    const colors = new Uint16Array([...Array(8).fill(0), ...Array(8).fill(1)]);
    const out = run({ job: 1, positions, ids, colors, indices, cell: 1 });
    assert.equal(out.pieces.length, 1, 'the sub-cell box collapses entirely');
    assert.equal(out.pieces[0]!.slot, 0);
    assert.equal(out.pieces[0]!.ids.length, 36, 'twelve big-box triangles survive, flat shaded');
    assert.ok([...out.pieces[0]!.ids].every((id) => id === 7));
  });
});
