/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The production defect itself, reproduced at the mount site (#2401).
 *
 * PostHog issue `019fc458-6640-7a23-8f8b-c1897bfd9b20` (Chrome 116 / Linux,
 * `https://www.ifclite.com/mcp`): `THREE.WebGLRenderer: Error creating WebGL
 * context.` thrown out of `HeroScene`'s mount effect, unwinding the whole
 * `/mcp` route into `App.tsx`'s `ChunkErrorBoundary`.
 *
 * happy-dom reproduces the device faithfully and for free: its
 * `canvas.getContext('webgl2')` returns `null`, which is exactly the condition
 * three.js turns into that throw. That is why `PlaygroundViewer.test.ts`
 * documents mounting the component as impossible — pre-fix, these renders
 * throw. So no fake is involved in the part that matters: the refusal is real,
 * three.js is real, React is real, and only the GPU is missing.
 *
 * Both surfaces are covered because they degrade differently on purpose: the
 * hero is decorative and gets a caption, the playground is functional and says
 * what still works.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HeroScene } from './HeroScene.js';
import { PlaygroundViewer } from './PlaygroundViewer.js';
import { resetThreeWebglSupportForTests, getThreeWebglVerdict } from './three-webgl-support.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetThreeWebglSupportForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('HeroScene on a device that refuses a WebGL context', () => {
  it('mounts without throwing and paints a caption instead of killing the page', () => {
    // Pre-fix this `act` throws: `createScene` reaches `new
    // THREE.WebGLRenderer` synchronously inside the mount effect.
    act(() => {
      root.render(<HeroScene step={0} />);
    });

    assert.match(container.textContent ?? '', /3D preview unavailable on this device/);
  });

  it('keeps advancing steps without a scene, instead of crashing on the next one', () => {
    // The parent (`McpLanding`'s `WireframeStage`) bumps `step` every 2 s
    // whether or not a scene exists. An update path that assumed a live handle
    // would turn one dead canvas into a crash a moment later.
    act(() => {
      root.render(<HeroScene step={0} />);
    });
    act(() => {
      root.render(<HeroScene step={7} />);
    });

    assert.match(container.textContent ?? '', /3D preview unavailable on this device/);
  });

  it('never asks the GPU again once the session verdict is latched', () => {
    // Counting real `<canvas>` creations is what makes this falsifiable on the
    // LATCH axis rather than only on the fallback axis: a browser hands out
    // ~16 live WebGL contexts per page, so a component that re-probed on every
    // remount could eventually cause the refusal it screens for.
    const realCreateElement = document.createElement.bind(document);
    let canvases = 0;
    document.createElement = ((tag: string, options?: ElementCreationOptions) => {
      if (String(tag).toLowerCase() === 'canvas') canvases += 1;
      return realCreateElement(tag, options);
    }) as typeof document.createElement;

    try {
      act(() => {
        root.render(<HeroScene step={0} />);
      });
      const first = getThreeWebglVerdict();
      assert.deepEqual(first, { supported: false, reason: 'probe_no_context' });
      assert.equal(canvases, 1, 'the first mount probes exactly once');

      // A remount (the /mcp hero sits inside a lazy route that can unmount)
      // must paint the fallback straight away rather than re-running the probe.
      act(() => root.unmount());
      root = createRoot(container);
      act(() => {
        root.render(<HeroScene step={0} />);
      });

      assert.match(container.textContent ?? '', /3D preview unavailable on this device/);
      assert.equal(canvases, 1, 'a remount must reuse the latched verdict, not burn a second context slot');
      assert.deepEqual(getThreeWebglVerdict(), first, 'the latched verdict must stand for the session');
    } finally {
      document.createElement = realCreateElement;
    }
  });
});

describe('PlaygroundViewer on a device that refuses a WebGL context', () => {
  it('mounts without throwing and says what still works', () => {
    act(() => {
      root.render(<PlaygroundViewer model={null} />);
    });

    const text = container.textContent ?? '';
    assert.match(text, /3D preview unavailable on this device/);
    assert.match(text, /queries/i);
    // The idle phase panel must not double up underneath the fallback.
    assert.doesNotMatch(text, /load a model first/);
  });
});
