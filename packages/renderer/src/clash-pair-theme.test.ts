/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A focused clash pair follows the theme in 3D (#5490).
 *
 * The pair is painted through `Scene.setColorOverrides`, whose colour table
 * retains the colour until it is rewritten. A theme switch only updated the
 * app's copy of the two tints, so the panel's side dots changed and the 3D
 * pair kept the old theme's colours. `setOverlayTheme` repaints every installed override
 * equal to the previous theme's `clashA` / `clashB` in the new ones.
 *
 * A real `Renderer` and `Scene`; only the GPU objects are stand-ins. The
 * scene has no meshes, but the entity colour table is still uploaded.
 * Each rebuild is recorded as a SNAPSHOT of the colours it was handed, because
 * that is what the batches are built from: a shared tuple mutated later would
 * make the retained map look right while the GPU showed the old colour.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from './index.js';
import { DEFAULT_OVERLAY_THEME, type OverlayTheme } from './overlay-theme.js';
import { remapOverrideColors } from './scene-derived-batches.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = { STORAGE: 128, COPY_DST: 8 };

type Rgba = [number, number, number, number];

const DARK: OverlayTheme = {
  ...DEFAULT_OVERLAY_THEME,
  clashA: [0xe0 / 255, 0xaf / 255, 0x68 / 255, 1],
  clashB: [0x7d / 255, 0xcf / 255, 0xff / 255, 1],
};
const LENS: Rgba = [0.2, 0.4, 0.6, 1];

function harness() {
  const renderer = new Renderer({
    width: 256,
    height: 256,
    getBoundingClientRect: () => ({ width: 256, height: 256 }),
  } as unknown as HTMLCanvasElement);
  const fields = renderer as unknown as Record<string, unknown>;
  const gpu = {
    limits: { maxStorageBufferBindingSize: 256 * 1024 * 1024 },
    createBuffer: ({ size }: { size: number }) => ({ size, destroy() {} }),
    queue: { writeBuffer() {} },
  };
  fields['device'] = { isInitialized: () => true, getDevice: () => gpu };
  fields['pipeline'] = { selectionColorUniform: { update() { /* not asserted */ } } };
  const scene = renderer.getScene() as unknown as {
    setColorOverrides(o: Map<number, Rgba>, d: unknown, p: unknown): void;
    getColorOverrides(): ReadonlyMap<number, readonly number[]> | null;
  };
  const builds: Array<Map<number, number[]>> = [];
  const real = scene.setColorOverrides.bind(scene);
  scene.setColorOverrides = (o, d, p) => {
    builds.push(new Map([...o].map(([id, c]) => [id, [...c]])));
    real(o, d, p);
  };
  const paint = (o: Map<number, Rgba>) => scene.setColorOverrides(o, gpu, fields['pipeline']);
  return { renderer, scene, builds, paint };
}

describe('the clash pair tints follow the overlay theme (#5490)', () => {
  it('a theme switch rebuilds the pair in the new clashA / clashB and leaves other colours alone', () => {
    const h = harness();
    h.paint(new Map<number, Rgba>([
      [1, [...DEFAULT_OVERLAY_THEME.clashA] as Rgba],
      [2, [...DEFAULT_OVERLAY_THEME.clashB] as Rgba],
      [3, [...LENS] as Rgba],
    ]));
    h.renderer.setOverlayTheme(DARK);

    assert.equal(h.builds.length, 2, 'one rebuild for the theme switch');
    assert.deepEqual(h.builds[1].get(1), [...DARK.clashA]);
    assert.deepEqual(h.builds[1].get(2), [...DARK.clashB]);
    assert.deepEqual(h.builds[1].get(3), LENS, 'a colour that is not a clash tint is not repainted');

    h.renderer.setOverlayTheme(DEFAULT_OVERLAY_THEME);
    assert.deepEqual(h.builds.at(-1)?.get(1), [...DEFAULT_OVERLAY_THEME.clashA], 'and back again');
  });

  it('no rebuild when nothing painted is a clash tint, or the tints did not change', () => {
    const h = harness();
    h.paint(new Map<number, Rgba>([[3, [...LENS] as Rgba]]));
    h.renderer.setOverlayTheme(DARK);
    assert.equal(h.builds.length, 1, 'a lens colouring is not rebuilt on a theme switch');

    const g = harness();
    g.paint(new Map<number, Rgba>([[1, [...DEFAULT_OVERLAY_THEME.clashA] as Rgba]]));
    g.renderer.setOverlayTheme({ ...DEFAULT_OVERLAY_THEME, selection: [1, 0, 0, 1] });
    assert.equal(g.builds.length, 1, 'a theme with the same clash tints costs no rebuild');
  });

  it('the caller mutating its tuple in place after painting does not hide the old colour from the repaint', () => {
    // The viewer keeps CLASH_COLOR_A as one array and rewrites it in place on a
    // theme change, BEFORE it calls setOverlayTheme. A retained map sharing that
    // tuple would already read the new colour, match no previous tint, and the
    // GPU would keep the old one.
    const h = harness();
    const pairA: Rgba = [...DEFAULT_OVERLAY_THEME.clashA] as Rgba;
    h.paint(new Map<number, Rgba>([[1, pairA]]));
    pairA.splice(0, 4, ...DARK.clashA);
    h.renderer.setOverlayTheme(DARK);
    assert.equal(h.builds.length, 2, 'the pair was rebuilt');
    assert.deepEqual(h.builds[1].get(1), [...DARK.clashA]);
  });
});

describe('remapOverrideColors', () => {
  it('returns null when no pair moves or nothing matches', () => {
    const one = new Map<number, Rgba>([[1, [1, 0, 0, 1]]]);
    assert.equal(remapOverrideColors(one, [[[1, 0, 0, 1], [1, 0, 0, 1]]]), null);
    assert.equal(remapOverrideColors(one, [[[0, 1, 0, 1], [0, 0, 1, 1]]]), null);
  });

  it('maps by the colour painted, so a swap of the two tints resolves each entry once', () => {
    const a: Rgba = [1, 0, 0, 1];
    const b: Rgba = [0, 0, 1, 1];
    const out = remapOverrideColors(new Map([[1, a], [2, b]]), [[a, b], [b, a]]);
    assert.deepEqual(out?.get(1), b);
    assert.deepEqual(out?.get(2), a);
  });
});
