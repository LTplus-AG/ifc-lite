/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `loadPlaygroundGeometry` (#1959 P0 leak) creates a GeometryProcessor per
 * call and, before the fix, never disposed it — including the `cancelled`
 * bail-out that fires on every model swap (the effect's cleanup flips
 * `cancelled` and a fresh IIFE starts for the new model, so a busy playground
 * session leaked one WASM handle per swap).
 *
 * This exercises the extracted loader function directly rather than
 * mounting `<PlaygroundViewer>`: mounting pulls in the "mount Three.js once"
 * effect, which constructs a real `THREE.WebGLRenderer` — happy-dom's
 * `canvas.getContext('webgl')` returns `null`, so that effect throws before
 * the geometry-loading effect under test ever gets to run, and there is no
 * existing pattern in this repo for stubbing a WebGL context convincingly
 * enough for `WebGLRenderer`'s capability-detection calls (`getParameter`,
 * `getExtension`, ...). Testing the disposal contract through the standalone
 * function is the proportionate alternative to building that stub.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { GeometryProcessor, type GeometryResult, type MeshData } from '@ifc-lite/geometry';
import { loadPlaygroundGeometry } from './PlaygroundViewer.js';
import { parsePlaygroundModel, type LoadedPlaygroundModel } from './playground-dispatcher.js';

function ifc4(body: string): string {
  return [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;',
    'DATA;', body, 'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
}

async function schemaOnlyModel(globalId: string): Promise<LoadedPlaygroundModel> {
  const bytes = new TextEncoder().encode(
    ifc4(`#1=IFCWALL('${globalId}',$,'Wall A',$,$,$,$,$,.STANDARD.);`),
  );
  return parsePlaygroundModel(bytes.buffer as ArrayBuffer, `${globalId}.ifc`);
}

/** A promise plus its resolver, so the test controls exactly when
 *  `processor.process()` settles relative to flipping `cancelled`. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('loadPlaygroundGeometry WASM disposal (#1959 P0 leak)', () => {
  it('disposes the GeometryProcessor handle when the caller cancels mid-flight', async () => {
    const gate = deferred<GeometryResult>();
    const initMock = mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
    const processMock = mock.method(GeometryProcessor.prototype, 'process', () => gate.promise);
    const disposeMock = mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
    const onMeshes = mock.fn((_meshes: MeshData[]) => undefined);
    try {
      let cancelled = false;
      const run = loadPlaygroundGeometry(await schemaOnlyModel('0aBcDeFgHiJkLmNoPqRsT3'), {
        isCancelled: () => cancelled,
        setPhase: () => undefined,
        setPhaseMsg: () => undefined,
        onMeshes,
      });

      // Mirrors the effect's cleanup: the model changed (or the component
      // unmounted) while `processor.process()` was still in flight.
      cancelled = true;
      gate.resolve({ meshes: [{ expressId: 1 }] } as unknown as GeometryResult);
      await run;

      assert.equal(disposeMock.mock.callCount(), 1, 'dispose runs exactly once on the cancelled bail-out');
      assert.equal(onMeshes.mock.callCount(), 0, 'the cancelled result must never reach the scene');
    } finally {
      initMock.mock.restore();
      processMock.mock.restore();
      disposeMock.mock.restore();
    }
  });

  it('disposes the GeometryProcessor handle on the empty-mesh branch', async () => {
    const initMock = mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
    const processMock = mock.method(GeometryProcessor.prototype, 'process', async () =>
      ({ meshes: [] }) as unknown as GeometryResult,
    );
    const disposeMock = mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
    const phases: string[] = [];
    try {
      await loadPlaygroundGeometry(await schemaOnlyModel('0aBcDeFgHiJkLmNoPqRsT4'), {
        isCancelled: () => false,
        setPhase: (p) => phases.push(p),
        setPhaseMsg: () => undefined,
        onMeshes: () => assert.fail('onMeshes must not fire for an empty mesh list'),
      });
      assert.deepEqual(phases, ['processing', 'error']);
      assert.equal(disposeMock.mock.callCount(), 1, 'dispose runs exactly once on the empty-mesh branch');
    } finally {
      initMock.mock.restore();
      processMock.mock.restore();
      disposeMock.mock.restore();
    }
  });

  it('disposes the GeometryProcessor handle on the success path', async () => {
    const oneTriangle = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 1, 1, 1] as [number, number, number, number],
      expressId: 1,
    };
    const initMock = mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
    const processMock = mock.method(GeometryProcessor.prototype, 'process', async () =>
      ({ meshes: [oneTriangle] }) as unknown as GeometryResult,
    );
    const disposeMock = mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
    const onMeshes = mock.fn((_meshes: MeshData[]) => undefined);
    try {
      await loadPlaygroundGeometry(await schemaOnlyModel('0aBcDeFgHiJkLmNoPqRsT5'), {
        isCancelled: () => false,
        setPhase: () => undefined,
        setPhaseMsg: () => undefined,
        onMeshes,
      });
      assert.equal(onMeshes.mock.callCount(), 1);
      assert.equal(disposeMock.mock.callCount(), 1, 'dispose runs exactly once on the success path');
    } finally {
      initMock.mock.restore();
      processMock.mock.restore();
      disposeMock.mock.restore();
    }
  });
});
