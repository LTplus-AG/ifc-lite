/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A geometry-stream failure is terminal for the model (#6721 review): the
 * inner geometry catch used to show the error but leave the model in
 * 'streaming-geometry', so it read as still loading and a later
 * stale-deployment reload resumed a load that had failed for its own reasons.
 * Driven through the real loadFile, parser and wasm engine; only the geometry
 * stream is made to throw.
 */
import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { hook, skip, blankFile } from '@/test/blank-ifc-loader-harness.js';
import { __resetStaleDeploymentForTests } from '@/lib/stale-deployment';
import { markLocalModelFiles, resumableFiles } from '@/lib/reload-resume';

function failGeometryWith(error: Error): void {
  // An async iterable whose first pull rejects: the stream fails before any batch.
  mock.method(GeometryProcessor.prototype, 'processAdaptive', () => ({
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error), return: async () => ({ done: true, value: undefined }) }),
  }));
}

afterEach(() => {
  mock.restoreAll();
  __resetStaleDeploymentForTests();
});

describe('geometry-stream failure leaves the model in a terminal state', () => {
  it('marks a non-stale geometry failure as error, so a stale reload does not resume it', { skip }, async () => {
    assert.ok(hook);
    failGeometryWith(new Error('geometry kernel exploded on element 42'));
    const file = blankFile('METRE');
    markLocalModelFiles([file]);
    const modelId = crypto.randomUUID();
    await act(async () => hook!.loadFile(file, { kind: 'primary', modelId }));

    const model = useViewerStore.getState().models.get(modelId);
    assert.equal(model?.loadState, 'error', 'not left in streaming-geometry');
    assert.match(model?.loadError ?? '', /exploded/);
    assert.equal(useViewerStore.getState().loading, false);
    assert.deepEqual(resumableFiles(useViewerStore.getState().models.values()), []);
  });

  it('still resumes a model whose geometry stream died of the stale deployment', { skip }, async () => {
    assert.ok(hook);
    failGeometryWith(new Error('Geometry worker failed: worker script failed to load (possibly a stale deployment)'));
    const file = blankFile('METRE');
    markLocalModelFiles([file]);
    const modelId = crypto.randomUUID();
    await act(async () => hook!.loadFile(file, { kind: 'primary', modelId }));

    assert.equal(useViewerStore.getState().models.get(modelId)?.loadState, 'error');
    assert.equal(useViewerStore.getState().error, null, 'the reload notice, not a generic error');
    assert.deepEqual(resumableFiles(useViewerStore.getState().models.values()).map((f) => f.name), [file.name]);
  });
});
