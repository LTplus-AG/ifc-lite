/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6431: before parsing, the loader keys the model's saved workspace
 * placements by a full-content identity. It used to compute it by re-reading
 * the whole file through `Blob.slice()` in 1 MiB chunks, although it had just
 * read the same bytes into memory; on a 1 GB file that was seconds of latency
 * before any geometry. The identity must come from the bytes in hand, and must
 * still be the file's identity.
 *
 * Like `useIfcLoader.sabStreaming.test.tsx`, the load stops after byte
 * acquisition under Node (no WASM engine); the identity is computed before
 * that point, so it is observable on the model record.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { placementSourceIdentity } from '@/lib/model-placement/source-identity';
import { useIfcLoader } from './useIfcLoader.js';

const STEP_BYTES = new TextEncoder().encode(
  "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n"
  + "FILE_NAME('identity.ifc','2026-01-01T00:00:00',(''),(''),'','','');\n"
  + "FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n",
);

let hookApi: ReturnType<typeof useIfcLoader> | null = null;
function Probe(): null {
  hookApi = useIfcLoader();
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(async () => {
  hookApi = null;
  useViewerStore.getState().resetViewerState();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  if (container) container.remove();
  container = null;
});

it('keys the model by its file identity without re-reading the file through Blob slices (#6431)', async () => {
  const file = new File([STEP_BYTES], 'identity.ifc');
  const expected = await placementSourceIdentity(new File([STEP_BYTES], 'reference.ifc'));
  // Only reads past the loader's 4 KiB format-detection head count: those are
  // the identity's chunk reads.
  let chunkReads = 0;
  const realSlice = file.slice.bind(file);
  Object.defineProperty(file, 'slice', {
    configurable: true,
    value: (start?: number, end?: number, type?: string): Blob => {
      if (!(start === 0 && end === 4096)) chunkReads++;
      return realSlice(start, end, type);
    },
  });

  await act(async () => {
    await hookApi!.loadFile(file);
  });

  const [model] = useViewerStore.getState().models.values();
  assert.ok(model, 'loadFile must have registered the model, or the read counter below is vacuous');
  assert.equal(model.sourceContentHash, expected, 'the identity is still the file identity');
  assert.equal(chunkReads, 0, 'the identity came from the bytes the loader already held');
});
