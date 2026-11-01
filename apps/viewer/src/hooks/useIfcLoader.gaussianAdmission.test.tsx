/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #8565: admission through the actual canonical loader, without a renderer. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useIfcLoader } from './useIfcLoader.js';

let loader: ReturnType<typeof useIfcLoader> | null = null;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function Probe() {
  loader = useIfcLoader();
  return null;
}

beforeEach(async () => {
  const state = useViewerStore.getState();
  state.setActiveLoadCanceller(null);
  state.resetViewerState();
  state.clearAllModels();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Probe />));
  assert.ok(loader);
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  host?.remove();
  host = null;
  loader = null;
});

const gaussianHeader = 'ply\nformat binary_little_endian 1.0\nelement vertex 1\n'
  + ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'].map(n => `property float ${n}\n`).join('')
  + 'end_header\n';
function capture() { return new File([gaussianHeader, new Uint8Array(56)], 'capture.ply'); }

it('primary Gaussian PLY is refused before point-cloud rendering or whole-file allocation (#8565)', async () => {
  const file = capture();
  file.arrayBuffer = async () => { throw new Error('unexpected whole-file read'); };
  await act(async () => loader!.loadFile(file, { kind: 'primary', modelId: 'capture' }));
  const state = useViewerStore.getState();
  assert.match(state.error ?? '', /Gaussian splat loading is disabled/);
  assert.equal(state.models.get('capture')?.loadState, 'error');
  assert.equal(state.pointCloudAssetCount, 0);
  assert.equal(state.loading, false);
  assert.equal(state.activeLoadCanceller, null);
});

for (const n of [1, 2]) it(`federated Gaussian refusal preserves ${n} existing models (#8565)`, async () => {
  const models = Array.from({ length: n }, (_, i) => fixtureModel(`existing-${i}`, { idOffset: i * 1_000_000 }));
  useViewerStore.setState({ ...fixtureModels(...models), selectedEntityId: 7 });
  const before = useViewerStore.getState();
  await act(async () => loader!.loadFile(new File([new Uint8Array(32)], 'capture.splat'), { kind: 'federated', modelId: 'refused' }));
  const after = useViewerStore.getState();
  assert.match(after.error ?? '', /Gaussian splat loading is disabled/);
  assert.equal(after.models, before.models);
  assert.equal(after.selectedEntityId, 7);
  assert.equal(after.models.has('refused'), false);
});

it('ordinary PLY still reaches the existing point-cloud renderer seam (#8565)', async () => {
  const file = new File(['ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n'], 'ordinary.ply');
  await act(async () => loader!.loadFile(file));
  assert.match(useViewerStore.getState().error ?? '', /Renderer not initialised/);
});

for (const action of ['cancel', 'supersede'] as const) it(`a ${action} during extended header inspection cannot publish a late refusal (#8565)`, async () => {
  const file = new File([gaussianHeader.replace('element vertex', `comment ${'a'.repeat(5000)}\nelement vertex`), new Uint8Array(56)], 'delayed.ply');
  let resolveRead!: (buffer: ArrayBuffer) => void;
  let readStarted!: () => void;
  const started = new Promise<void>(resolve => { readStarted = resolve; });
  const held = new Promise<ArrayBuffer>(resolve => { resolveRead = resolve; });
  const slice = file.slice.bind(file);
  file.slice = (start, end) => {
    const blob = slice(start, end);
    if (end === 65536) blob.arrayBuffer = () => { readStarted(); return held; };
    return blob;
  };
  let pending!: Promise<void>;
  await act(async () => { pending = loader!.loadFile(file); await started; });
  await act(async () => {
    if (action === 'cancel') useViewerStore.getState().activeLoadCanceller?.();
    else await loader!.loadFile(new File([new Uint8Array(31)], 'truncated.splat'));
  });
  const error = useViewerStore.getState().error;
  await act(async () => { resolveRead(await slice(0, 65536).arrayBuffer()); await pending; });
  assert.equal(useViewerStore.getState().error, error);
  assert.equal(useViewerStore.getState().loading, false);
  assert.equal(useViewerStore.getState().activeLoadCanceller, null);
});
