/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Painted (colour-overridden) surfaces win coplanar depth ties (#11405): the
 * level contract of `nudgedClipZ` (CPU mirror of `depth-nudge.wgsl.ts`), that
 * every derived mesh shader still declares what the painted nudge uses, and the
 * selection masks' colour-table group (`mask-color-table.ts`), which they need
 * to nudge exactly as the colour pass did.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DEPTH_NUDGE_HASH,
  ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL,
  ORTHOGRAPHIC_MAX_DEPTH_NUDGE_METRES,
  PAINTED_DEPTH_NUDGE_BIT,
  PERSPECTIVE_DEPTH_NUDGE_LEVEL_SHIFT,
  PERSPECTIVE_DEPTH_NUDGE_LEVELS,
  PERSPECTIVE_DEPTH_NUDGE_PER_LEVEL,
  PERSPECTIVE_MAX_DEPTH_NUDGE_RELATIVE,
  PERSPECTIVE_MAX_PAINTED_DEPTH_NUDGE_RELATIVE,
  PERSPECTIVE_PAINTED_DEPTH_NUDGE_LEVELS,
  orthographicPaintedLevels,
} from './shaders/depth-nudge.wgsl.js';
import { mainShaderSource } from './shaders/main.wgsl.js';
import { opaqueFastShaderSource } from './shaders/main-opaque-fast.wgsl.js';
import { streamShaderSource } from './shaders/main-stream.wgsl.js';
import { ghostShaderSource } from './shaders/ghost.wgsl.js';
import { texturedShaderSource } from './shaders/textured.wgsl.js';
import { guardedMeshShader, unbiasedMeshShader } from './shaders/opaque-visibility.wgsl.js';
import { MaskTableGroup, maskTableLayout } from './mask-color-table.js';

/** WGSL `nudgedClipZ`'s level, perspective (`orthoLevels` absent) or orthographic. */
function level(zHash: number, orthoLevels?: number): number {
  const hash = zHash & 255, painted = (zHash & PAINTED_DEPTH_NUDGE_BIT) !== 0;
  if (orthoLevels !== undefined) {
    const paintedLevels = orthographicPaintedLevels(orthoLevels);
    return painted ? orthoLevels + ((hash * paintedLevels) >> 8) : (hash * orthoLevels) >> 8;
  }
  return painted ? PERSPECTIVE_DEPTH_NUDGE_LEVELS + ((hash * PERSPECTIVE_PAINTED_DEPTH_NUDGE_LEVELS) >> 8) : hash >> PERSPECTIVE_DEPTH_NUDGE_LEVEL_SHIFT;
}

const HASHES = Array.from({ length: MAX_DEPTH_NUDGE_HASH + 1 }, (_, h) => h);

describe('painted surfaces win coplanar depth ties', () => {
  for (const ortho of [undefined, 1, 2, 7, 52, 256]) {
    it(`ranks every painted level above every unpainted one (${ortho === undefined ? 'perspective' : `orthographic, ${ortho} levels`})`, () => {
      const topUnpainted = Math.max(...HASHES.map((h) => level(h, ortho)));
      const bottomPainted = Math.min(...HASHES.map((h) => level(h | PAINTED_DEPTH_NUDGE_BIT, ortho)));
      assert.ok(bottomPainted > topUnpainted, `${bottomPainted} > ${topUnpainted}`);
    });
  }

  it('gives painted surfaces their own levels: a quarter of the unpainted steps, at least one (literal counts)', () => {
    for (const [levels, painted] of [[1, 1], [2, 1], [5, 1], [7, 1], [9, 2], [52, 12], [256, 63]] as const) {
      assert.equal(orthographicPaintedLevels(levels), painted, `${levels} levels`);
    }
    const distinct = (ortho?: number) => new Set(HASHES.map((h) => level(h | PAINTED_DEPTH_NUDGE_BIT, ortho))).size;
    assert.equal(distinct(), 8, 'perspective: 8 painted levels, so coplanar painted entities still rank');
    assert.equal(distinct(256), 63);
    assert.equal(distinct(52), 12);
    assert.equal(distinct(7), 1);
  });

  it('keeps a painted surface within 1.25 times the orthographic metre bound wherever five levels exist', () => {
    for (const range of [0.5, 10, 100, 205, 1_000, 1_560, 4_000, 7_400]) {
      const steps = ORTHOGRAPHIC_MAX_DEPTH_NUDGE_METRES / (range * ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL);
      const levels = Math.min(Math.max(Math.floor(steps), 0), MAX_DEPTH_NUDGE_HASH) + 1;
      const top = Math.max(...HASHES.map((h) => level(h | PAINTED_DEPTH_NUDGE_BIT, levels)));
      const metres = top * ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL * range;
      assert.ok(metres <= 1.25 * ORTHOGRAPHIC_MAX_DEPTH_NUDGE_METRES * (1 + 1e-12), `${range} m: ${metres} m`);
    }
  });

  it('leaves unpainted levels where they were: a scene without overrides is unchanged', () => {
    for (const h of HASHES) assert.equal(level(h), h >> PERSPECTIVE_DEPTH_NUDGE_LEVEL_SHIFT);
    for (const n of [1, 52, 256]) for (const h of HASHES) assert.equal(level(h, n), (h * n) >> 8);
  });

  it('moves a painted surface at most 2 mm at 100 m (perspective)', () => {
    const top = Math.max(...HASHES.map((h) => level(h | PAINTED_DEPTH_NUDGE_BIT)));
    assert.equal(top * PERSPECTIVE_DEPTH_NUDGE_PER_LEVEL, PERSPECTIVE_MAX_PAINTED_DEPTH_NUDGE_RELATIVE);
    assert.ok(PERSPECTIVE_MAX_PAINTED_DEPTH_NUDGE_RELATIVE > PERSPECTIVE_MAX_DEPTH_NUDGE_RELATIVE);
    const shift = 100 - 100 / (1 + PERSPECTIVE_MAX_PAINTED_DEPTH_NUDGE_RELATIVE);
    assert.ok(shift <= 0.002, `${shift} m at 100 m`);
  });

  it('every derived mesh shader declares the constants and painted-nudge helpers it uses', () => {
    // A derivation that drops a block (the unbiased ortho prepass replaces the depth-nudge block)
    // must not leave a use behind: the module would fail to compile and that pass would break.
    const derived: Record<string, string> = {
      main: mainShaderSource, fast: opaqueFastShaderSource, ghost: ghostShaderSource, textured: texturedShaderSource,
      stream: streamShaderSource(mainShaderSource), streamFast: streamShaderSource(opaqueFastShaderSource),
    };
    for (const [name, src] of Object.entries({ ...derived })) {
      derived[`${name}-unbiased`] = unbiasedMeshShader(src, 4, name === 'ghost' ? undefined : 'fs_main');
      derived[`${name}-guarded`] = guardedMeshShader(src, 4);
    }
    for (const [name, src] of Object.entries(derived)) {
      const code = src.replace(/\/\/[^\n]*/g, '');
      const constants = new Set([...code.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1]!));
      const functions = new Set([...code.matchAll(/\bfn\s+(\w+)\s*\(/g)].map((m) => m[1]!));
      for (const [, id] of code.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) assert.ok(constants.has(id!), `${name}: ${id} used but not declared`);
      for (const helper of ['nudgedClipZ', 'paintedNudgeBit', 'lanePaintedNudgeBit', 'entityOverrideById', 'resolveLaneEntityId']) {
        if (new RegExp(`\\b${helper}\\(`).test(code)) assert.ok(functions.has(helper), `${name}: ${helper} called but not declared`);
      }
    }
  });
});

describe('selection-mask colour-table group', () => {
  function fakeDevice() {
    const groups: { entries: { binding: number; resource: { buffer: unknown } }[] }[] = [];
    const buffers: { destroyed: boolean }[] = [];
    const layouts: GPUBindGroupLayoutDescriptor[] = [];
    const device = {
      createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => { layouts.push(d); return { d }; },
      createBindGroup: (d: { entries: { binding: number; resource: { buffer: unknown } }[] }) => { groups.push(d); return { n: groups.length }; },
      createBuffer: () => { const b = { destroyed: false, destroy() { b.destroyed = true; } }; buffers.push(b); return b; },
    } as unknown as GPUDevice;
    return { device, groups, buffers, layouts };
  }
  const g = globalThis as Record<string, unknown>;
  g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  g.GPUBufferUsage ??= { STORAGE: 128, UNIFORM: 64, COPY_DST: 8 };

  it('binds the scene table at binding 5 for the vertex stage, rebuilding only when the buffer is replaced', () => {
    const { device, groups } = fakeDevice();
    const plain = maskTableLayout(device, false) as unknown as { d: GPUBindGroupLayoutDescriptor };
    const entry = [...plain.d.entries].find((e) => e.binding === 5)!;
    assert.ok((entry.visibility & GPUShaderStage.VERTEX) !== 0, 'the vertex stage reads it');
    const table = new MaskTableGroup(device);
    const a = {} as GPUBuffer, b = {} as GPUBuffer;
    const first = table.get(a);
    assert.equal(table.get(a), first, 'a settled frame builds nothing');
    assert.notEqual(table.get(b), first, 'a grown table (new buffer) rebinds');
    assert.equal(groups.at(-1)!.entries.find((e) => e.binding === 5)!.resource.buffer, b);
  });

  it('keeps the instanced hover uniform at binding 0 beside the table', () => {
    const { device, groups } = fakeDevice();
    const hover = {} as GPUBuffer;
    new MaskTableGroup(device, hover).get({} as GPUBuffer);
    assert.deepEqual(groups[0]!.entries.map((e) => e.binding), [0, 5]);
    assert.equal(groups[0]!.entries[0]!.resource.buffer, hover);
  });

  it('binds an owned empty table when none is given, and frees it on destroy', () => {
    const { device, buffers } = fakeDevice();
    const table = new MaskTableGroup(device);
    table.get(null); table.get(undefined);
    assert.equal(buffers.length, 1, 'one empty table, reused');
    table.destroy();
    assert.ok(buffers.every((b) => b.destroyed));
  });
});
