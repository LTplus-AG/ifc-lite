/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The production defect itself, reproduced at the mount site (#2401).
 *
 * Field report, from a desktop Chrome on Linux: `THREE.WebGLRenderer: Error
 * creating WebGL context.` thrown out of `HeroScene`'s mount effect on the
 * `/mcp` route, unwinding the whole route into `App.tsx`'s
 * `ChunkErrorBoundary`.
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
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { HeroScene } from './HeroScene.js';
import { PlaygroundViewer } from './PlaygroundViewer.js';
import type { ViewerController } from './playground-viewer-types.js';
import { parsePlaygroundModel, type LoadedPlaygroundModel } from './playground-dispatcher.js';
import { resetThreeWebglSupportForTests, getThreeWebglVerdict } from './three-webgl-support.js';

/** A minimal real model, parsed the way the playground parses one. */
async function schemaOnlyModel(): Promise<LoadedPlaygroundModel> {
  const bytes = new TextEncoder().encode([
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;',
    'DATA;', "#1=IFCWALL('2401TESTWALL00000000AA',$,'Wall A',$,$,$,$,$,.STANDARD.);", 'ENDSEC;',
    'END-ISO-10303-21;', '',
  ].join('\n'));
  return parsePlaygroundModel(bytes.buffer as ArrayBuffer, 'guard.ifc');
}

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

  it('tells the agent-facing controller that WebGL is gone, after the re-render (#2412)', async () => {
    // The wiring the dispatcher's terminal answers stand on. Two failure modes
    // it has to survive, and only the second is obvious:
    //
    //   1. the flag is never exposed at all;
    //   2. the flag is exposed but `useImperativeHandle` does not list
    //      `unavailable` in its deps — the handle is a frozen closure, so it
    //      would keep answering `false` from the FIRST render, when the mount
    //      effect had not run yet. That is the #2412 loop moved one level down,
    //      and it is invisible unless the assertion happens after the commit
    //      that sets the state, which is what the async `act` below guarantees.
    const ref = { current: null } as React.RefObject<ViewerController | null>;
    await act(async () => {
      root.render(<PlaygroundViewer model={null} ref={ref} />);
    });

    assert.ok(ref.current, 'the controller must attach even when the canvas does not');
    const status = ref.current.status();
    assert.equal(status.webglUnavailable, true, 'the controller must report the device refusal');
    assert.equal(status.loaded, false, 'and it is emphatically not loaded');
  });

  it('starts no geometry work on the INITIAL refusal, not just afterwards', async () => {
    // Ordering is the whole point, so this drives the first mount with a model
    // already present (the real case: `McpPlayground` mounts the panel with
    // `model` set as soon as the user expands it). Both effects flush in the
    // same commit, so at the moment the geometry effect runs, `setUnavailable`
    // has been CALLED but the component has not re-rendered — a guard that
    // only reads `unavailable` is still `null` here and lets the pass through.
    //
    // `loadPlaygroundGeometry` checks `isCancelled()` only after `process()`
    // resolves, so a leaked first pass is not a near-miss: the entire WASM
    // boot and tessellation completes and its meshes are thrown away.
    const initMock = mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
    const processMock = mock.method(GeometryProcessor.prototype, 'process', async () => ({ meshes: [] }));
    const disposeMock = mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
    try {
      const model = await schemaOnlyModel();
      await act(async () => {
        root.render(<PlaygroundViewer model={model} />);
      });

      assert.match(container.textContent ?? '', /3D preview unavailable on this device/);
      assert.equal(initMock.mock.callCount(), 0, 'the WASM pipeline must never boot without a scene to draw into');
      assert.equal(processMock.mock.callCount(), 0, 'tessellation must never run for a renderer that does not exist');
    } finally {
      initMock.mock.restore();
      processMock.mock.restore();
      disposeMock.mock.restore();
    }
  });
});
