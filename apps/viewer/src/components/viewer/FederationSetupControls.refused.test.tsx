/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click, waitFor } from '@/test/render';
import { useViewerStore } from '@/store';
import { registerLocale, setLocale } from '@/i18n';
import { miscPanelsBRu } from '@/i18n/locales/ru/misc-panels-b';
import { Toaster } from '@/components/ui/toast';
import { FederationSetupControls } from './FederationSetupControls';
import { gaussianPly, gaussianTestRenderer, installInThreadGaussianWorker } from '@/test/gaussian-loader-harness';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { modelIndices } from '@/lib/model-placement/model-indices';
import type { FederationSetupFile, FederationSetupSlot } from '@/lib/federation/federationSetupFile';

// #8566: real file selection -> matching -> setup -> federation -> canonical
// load/admission/decoder -> publication/tags -> rendered toast. Only Worker and
// GPU boundaries use the existing recording harness; no hook returns are mocked.
const env = (globalThis as typeof globalThis & { __VITE_ENV__: Record<string, unknown> }).__VITE_ENV__;
let previousQualification: unknown;
let gpu: ReturnType<typeof gaussianTestRenderer>;
let worker: ReturnType<typeof installInThreadGaussianWorker>;
let ui: HTMLElement;

beforeEach(() => {
  previousQualification = env.VITE_GAUSSIAN_SPLATS;
  delete env.VITE_GAUSSIAN_SPLATS;
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  useViewerStore.setState({ modelTags: new Map(), modelTagAssignments: new Map(), anchorModelIdOverride: null });
  modelIndices(new Map());
  gpu = gaussianTestRenderer();
  worker = installInThreadGaussianWorker();
  setGlobalRendererRef({ current: gpu.renderer });
  registerLocale('ru', miscPanelsBRu);
  setLocale('en');
});
afterEach(() => {
  // Dismiss the actual toast store before unmounting, including persistent errors.
  for (const button of document.querySelectorAll('[data-toast-seq] button')) click(button);
  cleanup();
  useViewerStore.getState().clearAllModels();
  worker.restore();
  setGlobalRendererRef({ current: null });
  modelIndices(new Map());
  env.VITE_GAUSSIAN_SPLATS = previousQualification;
  setLocale('en');
});

const slot = (file: File, tag: string, anchor = false): FederationSetupSlot => ({
  name: file.name, fileSize: file.size, fingerprintHex: null,
  visible: false, collapsed: true, anchor, tagIds: [tag],
});
function setup(slots: FederationSetupSlot[]): FederationSetupFile {
  return { formatVersion: 2, slots, tags: slots.map(s => ({ id: s.tagIds[0], name: s.tagIds[0], color: '#123456' })) };
}
async function selectFiles(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function restore(saved: FederationSetupFile, files: File[], locale: 'en' | 'ru') {
  setLocale(locale);
  ui = render(<><FederationSetupControls /><Toaster /></>);
  const inputs = ui.querySelectorAll<HTMLInputElement>('input[type="file"]');
  await selectFiles(inputs[0], [new File([JSON.stringify(saved)], 'saved.federation.json')]);
  await waitFor(() => document.querySelector('[data-toast-seq]') !== null, 'setup parsed');
  await selectFiles(inputs[1], files);
  const label = locale === 'en' ? 'Restore federation' : 'Восстановить федерацию';
  const button = () => [...document.querySelectorAll('button')].find(b => b.textContent === label);
  await waitFor(() => !!button(), 'matched slots reviewed');
  assert.equal(button()!.disabled, false);
  click(button()!);
  const prefix = locale === 'en' ? 'Restored ' : 'Восстановлено моделей:';
  const message = () => [...document.querySelectorAll('[data-toast-seq]')].find(e => e.textContent?.startsWith(prefix));
  await waitFor(() => !!message(), 'canonical loads settled and result shown');
  return message()!.textContent!;
}

for (const locale of ['en', 'ru'] as const) {
  it(`all found captures refused: preserve each reason, never claim missing sources (${locale}, #8566)`, async () => {
    const a = gaussianPly('first.ply', [[1, 2, 3]]);
    const b = gaussianPly('second.ply', [[4, 5, 6]]);
    const message = await restore(setup([slot(a, 'first-tag', true), slot(b, 'second-tag')]), [a, b], locale);
    assert.match(message, /0\/2/);
    assert.ok(message.includes(locale === 'en' ? 'source files found but not loaded:' : 'исходные файлы найдены, но не загружены:'));
    assert.match(message, /first\.ply \(Gaussian splat loading is disabled/);
    assert.match(message, /second\.ply \(Gaussian splat loading is disabled/);
    assert.ok(!message.includes(locale === 'en' ? 'source files missing:' : 'исходные файлы не найдены:'));
    assert.ok(message.includes(locale === 'en' ? 'alignment anchor could not be restored' : 'не удалось восстановить опорную модель'));
    const state = useViewerStore.getState();
    assert.equal(state.models.size, 0);
    assert.equal(state.modelTagAssignments.size, 0);
    assert.equal(state.modelTags.size, 0);
    assert.equal(state.anchorModelIdOverride, null);
    assert.equal(worker.stats.created, 0, 'public refusal occurs before decoding');
    assert.equal(gpu.renderer.gaussianSplats.getStats().assets, 0);
  });

  it(`mixed success, failed source and missing source retain only successful assignments (${locale}, #8566)`, async () => {
    env.VITE_GAUSSIAN_SPLATS = 'internal-unqualified';
    const good = gaussianPly('good.ply', [[1, 2, 3], [4, 5, 6]]);
    const broken = new File([new Uint8Array(31)], 'broken.splat');
    const missing = gaussianPly('missing.ply', [[1, 2, 3]]);
    const message = await restore(setup([slot(good, 'good-tag', true), slot(broken, 'failed-tag'), slot(missing, 'missing-tag')]), [good, broken], locale);
    assert.match(message, /1\/3/);
    assert.ok(message.includes(locale === 'en' ? 'source files missing: missing.ply' : 'исходные файлы не найдены: missing.ply'));
    assert.ok(message.includes(locale === 'en' ? 'source files found but not loaded: broken.splat (' : 'исходные файлы найдены, но не загружены: broken.splat ('));
    const state = useViewerStore.getState();
    assert.ok(state.error, 'canonical loader supplies the per-slot failure');
    assert.ok(message.includes(state.error));
    assert.match(message, /Truncated or empty \.splat input \(32-byte records required\)\./);
    assert.equal(state.models.size, 1);
    const model = [...state.models.values()][0];
    assert.equal(model.name, good.name);
    assert.equal(model.loadPath, 'gaussian');
    assert.equal(model.sourceFile, good);
    assert.equal(model.visible, false);
    assert.equal(model.collapsed, true);
    assert.deepEqual([...state.modelTagAssignments], [[model.id, new Set(['good-tag'])]]);
    assert.deepEqual([...state.modelTags.keys()], ['good-tag']);
    assert.equal(state.anchorModelIdOverride, model.id);
    assert.equal(gpu.renderer.gaussianSplats.getStats().assets, 1);
    assert.ok(worker.stats.created > 0, 'successful slot used the real decoder transport');
    assert.equal(worker.stats.created, worker.stats.terminated);
  });
}
