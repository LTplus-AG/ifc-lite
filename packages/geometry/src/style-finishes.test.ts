/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { applyStyleFinishes, buildPrePassWithFinishes, forgetAppliedFinishes } from './style-finishes.js';
import { runPrepassWithFingerprint } from './prepass-source-fingerprint.js';

describe('applyStyleFinishes after a content install (#7782 C4-11a)', () => {
  const ids = new Uint32Array([1]);
  const finishes = new Float32Array([0.5]);

  it('dedupes the same array until the instance forgets it', () => {
    const api = { setStyleFinishes: vi.fn() };
    applyStyleFinishes(api, ids, finishes);
    applyStyleFinishes(api, ids, finishes);
    expect(api.setStyleFinishes).toHaveBeenCalledTimes(1);
    forgetAppliedFinishes(api);
    applyStyleFinishes(api, ids, finishes);
    expect(api.setStyleFinishes).toHaveBeenCalledTimes(2);
  });

  it('re-sends the same finishes after buildPrePassOnce clears them in Rust', () => {
    const prePass = { styleIds: ids, styleFinishes: finishes };
    const api = { setStyleFinishes: vi.fn(), buildPrePassOnce: vi.fn(() => prePass) };
    buildPrePassWithFinishes(api, new Uint8Array());
    buildPrePassWithFinishes(api, new Uint8Array());
    expect(api.setStyleFinishes).toHaveBeenCalledTimes(2);
  });

  it('re-sends the same finishes after a streaming prepass on the instance', () => {
    const api = { setStyleFinishes: vi.fn(), buildPrePassStreaming: vi.fn(), buildPrePassStreamingSharded: vi.fn() };
    applyStyleFinishes(api, ids, finishes);
    runPrepassWithFingerprint(api, [new Uint8Array(), () => {}, 0, undefined, false]);
    applyStyleFinishes(api, ids, finishes);
    expect(api.setStyleFinishes).toHaveBeenCalledTimes(2);
  });
});
