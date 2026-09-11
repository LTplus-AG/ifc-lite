/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { act } from 'react';
import { render, cleanup, advance } from '@/test/render.js';
import { AppearancePanel } from './AppearancePanel.js';
import { useViewerStore } from '@/store';
import { appearanceAssets } from '@/lib/appearance/model-assets.js';

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
const assetId = createHash('sha256').update(png).digest('hex');
async function upload(ui: HTMLElement): Promise<void> {
  const picker = ui.querySelector<HTMLInputElement>('input[type=file]');
  assert.ok(picker);
  const transfer = new window.DataTransfer();
  transfer.items.add(new window.File([png], 'owned.png', { type: 'image/png' }));
  Object.defineProperty(picker, 'files', { configurable: true, value: transfer.files });
  await act(async () => picker.dispatchEvent(new window.Event('change', { bubbles: true })));
  for (let i = 0; i < 100; i++) {
    await advance(10);
    if (!picker.disabled) return;
  }
  assert.fail('Upload did not finish');
}
for (const failure of ['thumbnail', 'catalog', 'published', 'duplicate'] as const) {
  it(`mounted upload ownership #4243: ${failure}`, async t => {
    const initial = useViewerStore.getState();
    useViewerStore.setState({ models: new Map(), activeModelId: null,
      appearanceSources: [], appearanceDraft: null, collabRoomId: null });
    let allocations = 0;
    const revoked: string[] = [];
    t.mock.method(URL, 'createObjectURL', () => {
      allocations++;
      if (failure === 'thumbnail' || (failure === 'duplicate' && allocations > 1)) throw new Error('Injected thumbnail failure');
      return `blob:upload-${allocations}`;
    });
    t.mock.method(URL, 'revokeObjectURL', (url: string) => { revoked.push(url); });
    const publish = initial.addAppearanceSource;
    if (failure === 'catalog' || failure === 'published') {
      useViewerStore.setState({ addAppearanceSource: source => {
        if (failure === 'published') publish(source);
        throw new Error('Injected catalog failure');
      } });
    }
    try {
      const ui = render(<AppearancePanel />);
      await upload(ui);
      if (failure === 'thumbnail' || failure === 'catalog') {
        assert.equal(allocations, 1, 'the upload reached the injected host boundary');
        assert.equal(useViewerStore.getState().appearanceSources.length, 0);
        assert.equal(appearanceAssets.get(assetId), undefined, 'failed adoption releases both draft and provisional source ownership');
        assert.deepEqual(revoked, failure === 'catalog' ? ['blob:upload-1'] : []);
      } else {
        if (failure === 'duplicate') {
          await upload(ui);
          assert.equal(allocations, 1, 'reusing the catalog source must not allocate another thumbnail');
        }
        assert.equal(useViewerStore.getState().appearanceSources.length, 1);
        assert.ok(appearanceAssets.get(assetId), 'published catalog entry retains its image');
        assert.deepEqual(revoked, [], 'adopted thumbnail remains usable');
        await act(async () => useViewerStore.getState().removeAppearanceSource(assetId));
        assert.equal(appearanceAssets.get(assetId), undefined);
        assert.deepEqual(revoked, ['blob:upload-1']);
      }
    } finally {
      cleanup();
      for (const source of useViewerStore.getState().appearanceSources) useViewerStore.getState().removeAppearanceSource(source.id);
      appearanceAssets.clear();
      useViewerStore.setState(initial, true);
    }
  });
}
