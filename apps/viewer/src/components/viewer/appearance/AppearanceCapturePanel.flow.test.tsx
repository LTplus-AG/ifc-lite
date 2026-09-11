/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import 'fake-indexeddb/auto';
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { initSync } from '@ifc-lite/wasm';
import { useViewerStore } from '@/store';
import { render, cleanup, click, advance } from '@/test/render';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { AppearanceCapturePanel } from './AppearanceCapturePanel';

// A real 1x1 PNG: the GLB image reader verifies the encoded signature (#4397).
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));

/** One textured triangle as a photogrammetry export ships it: .gltf + .bin + texture. */
function scanBundle(): File[] {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  const bin = new Uint8Array(positions.byteLength + uvs.byteLength);
  bin.set(new Uint8Array(positions.buffer)); bin.set(new Uint8Array(uvs.buffer), positions.byteLength);
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, extras: { expressId: 42 } }],
    buffers: [{ uri: 'scan.bin', byteLength: bin.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }, { buffer: 0, byteOffset: positions.byteLength, byteLength: uvs.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' }],
    images: [{ uri: 'scan.png' }], textures: [{ source: 0 }], materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
  };
  return [new File([JSON.stringify(json)], 'scan.gltf'), new File([bin], 'scan.bin'), new File([png], 'scan.png', { type: 'image/png' })];
}

class OpaqueCanvas {
  width = 1;
  getContext() { return { clearRect() {}, drawImage() {}, getImageData() { return { data: new Uint8ClampedArray([255, 0, 0, 255]) }; } }; }
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1500; i++) { if (condition()) return; await advance(10); }
  assert.fail(`Timed out waiting for ${what}`);
}

// The blank IFC4 destination is parsed by the real engine. Under happy-dom the
// bridge takes its browser path (`window` exists) and would fetch the binary
// over file://, so pre-load the shared module from disk the way
// `useClash.solid-inflight-invalidation.test.tsx` does; skip when it is absent.
const wasmPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..', 'packages', 'wasm', 'pkg', 'ifc-lite_bg.wasm');

const decoder = globalThis.createImageBitmap, canvas = globalThis.OffscreenCanvas;
afterEach(() => {
  cleanup();
  Object.defineProperty(globalThis, 'createImageBitmap', { value: decoder, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'OffscreenCanvas', { value: canvas, configurable: true, writable: true });
  useViewerStore.getState().resetViewerState(); useViewerStore.getState().clearAllModels();
});

test('first-user path: a glTF scan bundle uploaded in the panel reaches the canonical loader, then a blank IFC4 destination is created in-flow without losing the region (#4477)', async t => {
  if (!existsSync(wasmPath)) { t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh` first'); return; }
  initSync({ module: readFileSync(wasmPath) });
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, writable: true, value: async () => ({ width: 1, height: 1, close() {} }) });
  Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, writable: true, value: OpaqueCanvas });
  useViewerStore.getState().resetViewerState(); useViewerStore.getState().clearAllModels();
  useViewerStore.setState({ selectedEntityId: null, modelPlacement: emptyPlacementState(), collabRoomId: null, mutationViews: new Map() });
  const ui = render(<AppearanceCapturePanel />);
  const source = ui.querySelector<HTMLSelectElement>('select[aria-label="Captured source surface"]')!;
  assert.equal(source.options.length, 1, 'nothing to capture before a scan is loaded');

  const picker = ui.querySelector<HTMLInputElement>('input[aria-label="Add scan files"]')!;
  const transfer = new window.DataTransfer();
  for (const file of scanBundle()) transfer.items.add(file);
  Object.defineProperty(picker, 'files', { configurable: true, value: transfer.files });
  await act(async () => picker.dispatchEvent(new window.Event('change', { bubbles: true })));
  // The scan is listed the moment the loader publishes it; the region follows once its images settle.
  await until(() => /1 triangle in this region/.test(ui.textContent ?? ''), 'the packed scan to load and its region to be prepared');
  const [scan] = [...useViewerStore.getState().models.values()];
  assert.equal(scan.name, 'scan.glb', 'the bundle was packed into one GLB and loaded as a model');
  assert.equal(scan.loadState, 'complete');
  assert.ok(scan.geometryResult?.meshes[0]?.textureRef, 'the loaded surface carries its base-colour texture');
  assert.equal(source.value, `${scan.id}:0`);

  const destination = ui.querySelector<HTMLSelectElement>('select[aria-label="Capture destination model"]')!;
  assert.equal(destination.value, '', 'a scan is not an editable destination');
  click([...ui.querySelectorAll('button')].find(button => button.textContent === 'New IFC4 model')!);
  await until(() => destination.value !== '', 'the blank IFC4 model to be created and chosen as destination');
  const created = useViewerStore.getState().models.get(destination.value);
  assert.ok(created && created.id !== scan.id, 'the destination is the model created in-flow');
  assert.equal(useViewerStore.getState().models.size, 2, 'the scan stays loaded beside its destination');
  assert.equal(source.value, `${scan.id}:0`, 'the chosen source survives adding the destination');
  assert.match(ui.textContent ?? '', /1 triangle in this region/);
  assert.match(ui.textContent ?? '', /selected scan region is still ready/);
});
