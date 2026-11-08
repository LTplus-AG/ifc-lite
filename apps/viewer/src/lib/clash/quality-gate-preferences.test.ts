/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { loadQualityGateConfig, useQualityGatePreferences } from './quality-gate-preferences';
import { defaultQualityGateConfig } from './quality-gate';

it('preserves corrupt quality preferences and refuses a quota failure without changing the policy (#9259)', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const entries = new Map<string, string>();
  let failWrites = false;
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failWrites) throw new DOMException('Quota full', 'QuotaExceededError');
      entries.set(key, value);
    },
    removeItem: (key: string) => { entries.delete(key); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    entries.set('ifc-lite-clash-quality-gates', '{broken');
    assert.deepEqual(loadQualityGateConfig(), defaultQualityGateConfig());
    assert.equal(entries.get('ifc-lite-clash-quality-gates:unreadable'), '{broken');
    const previous = useQualityGatePreferences.getState().config;
    const next = defaultQualityGateConfig(); next.clash[0].label = 'Custom threshold';
    failWrites = true;
    assert.equal(useQualityGatePreferences.getState().save(next), false);
    assert.equal(useQualityGatePreferences.getState().config, previous);
    failWrites = false;
    assert.equal(useQualityGatePreferences.getState().save(next), true);
    assert.equal(loadQualityGateConfig().clash[0].label, 'Custom threshold');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
