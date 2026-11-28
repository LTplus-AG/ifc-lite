/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The selection highlight and its masks redraw a surface with
 * `'greater-equal'`, no depth write and no bias, over depth that another
 * module wrote: the draw stream (`main-stream.wgsl.ts`), the discard-free
 * twin, the orthographic prepass and guard, or the main module itself. That
 * only works when every one of those vertex stages computes the SAME clip
 * position bits for the same vertex. WGSL promises that across modules and
 * pipelines only for an `@invariant` position: without it Metal compiled the
 * draw stream's position math differently from the highlight's, and a
 * selected roof showed its base colour through the highlight in blocky
 * patches that moved with the camera.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mainShaderSource } from './shaders/main.wgsl.js';
import { opaqueFastShaderSource } from './shaders/main-opaque-fast.wgsl.js';
import { streamShaderSource } from './shaders/main-stream.wgsl.js';
import { ghostShaderSource } from './shaders/ghost.wgsl.js';
import { texturedShaderSource } from './shaders/textured.wgsl.js';
import { guardedMeshShader, unbiasedMeshShader } from './shaders/opaque-visibility.wgsl.js';
import { glassDepthShader } from './gaussian/gaussian-glass-split.js';

/** Every mesh module whose depth a highlight or mask redraw must match (as `painted-depth-nudge.test.ts` lists them). */
function meshModules(): Record<string, string> {
  const modules: Record<string, string> = {
    main: mainShaderSource, fast: opaqueFastShaderSource, ghost: ghostShaderSource, textured: texturedShaderSource,
    stream: streamShaderSource(mainShaderSource), streamFast: streamShaderSource(opaqueFastShaderSource),
    // The geometric mask's vertex module (selection-mask-pipelines.ts).
    geometricMask: mainShaderSource.replace('@location(8) @interpolate(linear)', '@location(8) @interpolate(linear, sample)'),
    glassDepth: glassDepthShader(mainShaderSource),
  };
  for (const name of ['main', 'fast', 'ghost', 'textured', 'stream', 'streamFast']) {
    modules[`${name}-unbiased`] = unbiasedMeshShader(modules[name]!, 4, name === 'ghost' ? undefined : 'fs_main');
    modules[`${name}-guarded`] = guardedMeshShader(modules[name]!, 4);
  }
  return modules;
}

/** Each `@vertex fn` entry and the struct (or bare builtin) it returns. */
function vertexEntries(code: string): { name: string; returns: string }[] {
  // Parameters may carry attributes with parentheses (`@builtin(instance_index)`): the lazy match extends to the `->`.
  return [...code.matchAll(/@vertex\s+fn\s+(\w+)\s*\([\s\S]*?\)\s*->\s*([^{]+)\{/g)].map((m) => ({ name: m[1]!, returns: m[2]!.trim() }));
}

function structBody(code: string, name: string): string | null {
  const m = new RegExp(`struct\\s+${name}\\s*\\{([^}]*)\\}`).exec(code);
  return m ? m[1]! : null;
}

describe('mesh vertex stages write an invariant position', () => {
  for (const [name, source] of Object.entries(meshModules())) {
    it(`${name}: every vertex entry returns @invariant @builtin(position)`, () => {
      const code = source.replace(/\/\/[^\n]*/g, '');
      const entries = vertexEntries(code);
      assert.ok(entries.length > 0, `${name}: no vertex entry found`);
      for (const entry of entries) {
        const body = structBody(code, entry.returns);
        const declaration = body ?? entry.returns;
        assert.ok(/@builtin\(position\)/.test(declaration), `${name}.${entry.name}: returns ${entry.returns} without a position`);
        assert.ok(/@invariant\s+@builtin\(position\)/.test(declaration),
          `${name}.${entry.name}: ${entry.returns}'s position is not @invariant, so its depth may differ from the highlight redraw's`);
      }
    });
  }

  it('names the entries the highlight, masks and stream draw with', () => {
    const entries = (source: string) => vertexEntries(source.replace(/\/\/[^\n]*/g, '')).map((e) => e.name);
    for (const entry of ['vs_main', 'vs_main_quantized', 'vs_instanced']) assert.ok(entries(mainShaderSource).includes(entry), entry);
    for (const entry of ['vs_stream', 'vs_stream_quantized']) assert.ok(entries(streamShaderSource(mainShaderSource)).includes(entry), entry);
  });

  it('vs_main computes its position with the same statements as shadeFlatVertex (stream and quantized highlight)', () => {
    // Invariance only promises equal bits for the same expression: non-quantized highlights draw with
    // vs_main while the stream draws through shadeFlatVertex, so the two position chains must not drift.
    const code = mainShaderSource.replace(/\/\/[^\n]*/g, '');
    const body = (header: RegExp) => {
      const start = code.search(header);
      assert.ok(start >= 0, `${header} not found`);
      return code.slice(start, code.indexOf('return output;', start));
    };
    const chain = (src: string, local: string) => src.split(';').map((l) => l.replace(/\s+/g, ' ').trim())
      .filter((l) => /^(let (worldPos|eyePos|rte|zHash) =|output\.(position|geometricDepth)\b)/.test(l))
      .map((l) => l.split(local).join('LOCAL').replace('LOCAL_ID', 'ENTITY'));
    const flat = chain(body(/fn\s+shadeFlatVertex\s*\(/).replace(/\bentityId\b/g, 'LOCAL_ID'), 'localPos');
    const main = chain(body(/fn\s+vs_main\s*\(/).replace(/\binput\.entityId\b/g, 'LOCAL_ID'), 'input.position');
    assert.equal(flat.length, 7, `shadeFlatVertex position chain: ${flat.join(' | ')}`);
    assert.deepEqual(main, flat);
  });
});

