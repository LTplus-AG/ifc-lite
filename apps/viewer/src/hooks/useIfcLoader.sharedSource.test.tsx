/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { WorkerParser } from '@ifc-lite/parser/browser';
import { useViewerStore } from '@/store';
import { skip, blankFile, load } from '@/test/blank-ifc-loader-harness.js';

const REPORTED_LARGE_SIZE = 256 * 1024 * 1024 + 1;

/** The real canonical hook, parser fallback and WASM run. Only Node's absent
 * parser-worker transport deliberately rejects, after observing its input.
 * The source-size fixture selects shared acquisition without a 256 MiB test
 * allocation. No parser, geometry, event or loaded-model result is mocked. */
async function observeLoad(file: File, modelId?: string) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  Object.defineProperty(file, 'size', { value: REPORTED_LARGE_SIZE });
  const RealShared = SharedArrayBuffer;
  let acquired: SharedArrayBuffer | undefined;
  const recording = function(size: number): SharedArrayBuffer {
    const buffer = new RealShared(size === REPORTED_LARGE_SIZE ? bytes.length : size);
    if (size === REPORTED_LARGE_SIZE) acquired = buffer;
    return buffer;
  } as unknown as SharedArrayBufferConstructor;
  Object.defineProperty(recording, 'prototype', { value: RealShared.prototype });
  const parserSources: SharedArrayBuffer[] = [];
  const geometrySources: ArrayBufferLike[] = [];
  const adaptive = GeometryProcessor.prototype.processAdaptive;
  const supported = mock.method(WorkerParser, 'isSupported', () => true);
  const parser = mock.method(WorkerParser.prototype, 'parseColumnar', async function(source: SharedArrayBuffer) {
    parserSources.push(source);
    throw new Error('Intentional Node parser-worker startup refusal (#6537 source handoff control)');
  });
  const geometry = mock.method(GeometryProcessor.prototype, 'processAdaptive', async function*(
    this: GeometryProcessor,
    source: Parameters<typeof adaptive>[0],
    options: Parameters<typeof adaptive>[1],
  ) {
    geometrySources.push(source.buffer);
    yield* adaptive.call(this, source, options);
  });
  const originalSlice = Uint8Array.prototype.slice;
  let wholeSourceCopies = 0;
  Uint8Array.prototype.slice = function(start?: number, end?: number) {
    if (this.buffer === acquired && this.byteLength === bytes.length) wholeSourceCopies++;
    return originalSlice.call(this, start, end);
  };
  globalThis.SharedArrayBuffer = recording;
  try {
    const model = await load(file, modelId);
    assert.ok(acquired, 'the actual acquisition streamed into the observed SAB');
    assert.ok(parserSources.length > 0, 'the loader called the parser-worker boundary before fallback');
    assert.ok(geometrySources.length > 0, 'the real WASM geometry path was entered');
    return { model, acquired, parserSources, geometrySources, wholeSourceCopies, bytes };
  } finally {
    globalThis.SharedArrayBuffer = RealShared;
    Uint8Array.prototype.slice = originalSlice;
    supported.mock.restore();
    parser.mock.restore();
    geometry.mock.restore();
  }
}

for (const count of [1, 2]) {
  it(`plain shared IFC uses original source for real WASM and parser fallback, ${count} completed models (#6537)`, { skip }, async () => {
    const primary = await observeLoad(blankFile('METRE'));
    let observation = primary;
    if (count === 2) observation = await observeLoad(blankFile('MILLIMETRE'), 'peer');
    assert.equal(useViewerStore.getState().models.size, count);
    for (const item of new Set([primary, observation])) {
      assert.equal(item.wholeSourceCopies, 0, 'ordinary IFC must not allocate a duplicate whole source');
      assert.ok(item.geometrySources.every(source => source === item.acquired));
      assert.ok(item.parserSources.every(source => source === item.acquired));
      const store = item.model.ifcDataStore;
      assert.ok(store);
      assert.ok(store.entityIndex.byType.get('IFCPROJECT')?.length);
      assert.equal(store.source.slice(0, item.bytes.length).buffer, item.acquired);
      assert.deepEqual(store.source.slice(0, item.bytes.length), item.bytes);
    }
  });
}

it('shared IFCZIP geometry and metadata consume extracted model, never archive source (#6537)', { skip }, async () => {
  const content = await blankFile('METRE').text();
  const zip = new JSZip();
  zip.file('Models/model.ifc', content);
  const archive = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
  const item = await observeLoad(new File([archive], 'shared.ifcZIP'));
  assert.ok(item.geometrySources.every(source => source !== item.acquired));
  assert.ok(item.parserSources.every(source => source !== item.acquired));
  assert.equal(item.geometrySources[0], item.parserSources[0]);
  assert.equal(item.parserSources[0].byteLength, new TextEncoder().encode(content).length);
  assert.deepEqual([...new Uint8Array(item.parserSources[0])], [...new TextEncoder().encode(content)]);
  assert.ok(item.model.ifcDataStore?.entityIndex.byType.get('IFCPROJECT')?.length);
});
