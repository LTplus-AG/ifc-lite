/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { File as NodeFile, Blob as NodeBlob } from 'node:buffer';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { identifyLoadedPlacementSource } from './loaded-source-identity';

for (const removed of [false, true]) it(`hashes a completed scan without blocking its use and stops on removal: ${removed} (#4226)`, async () => {
  let reads = 0, release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  class Scan extends NodeFile {
    override slice(start?: number, end?: number, type?: string): NodeBlob {
      reads++;
      const chunk = super.slice(start, end, type);
      const read = chunk.arrayBuffer.bind(chunk);
      chunk.arrayBuffer = async () => { await blocked; return read(); };
      return chunk;
    }
  }
  const sourceFile = new Scan([new Uint8Array(2_000_000)], 'scan.xyz') as unknown as File;
  const model = { ...fixtureModel('scan'), sourceFile, sourceContentHash: undefined };
  useViewerStore.setState({ ...fixtureModels(model), loading: false });
  const pending = identifyLoadedPlacementSource('scan', sourceFile);
  assert.equal(useViewerStore.getState().loading, false);
  assert.equal(useViewerStore.getState().models.get('scan')?.sourceFile, sourceFile);
  assert.equal(reads, 1);
  if (removed) useViewerStore.setState({ models: new Map() });
  release(); await pending;
  if (removed) {
    assert.equal(reads, 1); assert.equal(useViewerStore.getState().models.size, 0, 'no resurrection after removal');
  } else assert.match(useViewerStore.getState().models.get('scan')!.sourceContentHash!, /^placement-sha256-1m-v1:[0-9a-f]{64}$/);
});
