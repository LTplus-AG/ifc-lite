/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FLOW_VERSION } from '@ifc-lite/flow';
import { loadSavedFlows, saveFlows, newFlowDocument } from './persistence';
// The persisted storage key is a backwards compatibility contract (#6612).
const GRAPHS_KEY = 'ifc-lite-flows';
afterEach(() => {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key?.startsWith(GRAPHS_KEY)) localStorage.removeItem(key);
  }
});
describe('saved Flow library boundaries (#6612)', () => {
  it('migrates saved v1 graphs before validation instead of discarding them', () => {
    const doc = { ...newFlowDocument('Legacy'), flowVersion: 1 };
    localStorage.setItem(GRAPHS_KEY, JSON.stringify({ schemaVersion: 1, flows: [{ doc, updatedAt: 1 }] }));
    const [saved] = loadSavedFlows();
    assert.equal(saved.doc.flowVersion, FLOW_VERSION); assert.equal(saved.doc.id, doc.id); assert.equal(saved.doc.name, 'Legacy');
    assert.equal(saved.updatedAt, 1);
  });
  it('preserves the complete damaged original while recovering valid neighbors', () => {
    const entry = { doc: newFlowDocument('Kept'), updatedAt: 1 };
    const raw = JSON.stringify({ schemaVersion: 1, flows: [entry, { doc: { broken: true }, updatedAt: 2 }] });
    localStorage.setItem(GRAPHS_KEY, raw);
    assert.deepEqual(loadSavedFlows(), [entry]);
    assert.equal(localStorage.getItem(`${GRAPHS_KEY}:unreadable`), raw);
    assert.equal(saveFlows([entry]), true);
    assert.equal(loadSavedFlows().length, 1);
    assert.equal(localStorage.getItem(`${GRAPHS_KEY}:unreadable`), raw);
  });
  it('reports a refused write without throwing or overwriting the stored library', () => {
    const saved = { doc: newFlowDocument('Saved'), updatedAt: 1 };
    assert.equal(saveFlows([saved]), true);
    const storage = localStorage;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage),
      setItem: () => { throw new Error('quota'); },
    } });
    try { assert.equal(saveFlows([{ doc: newFlowDocument('Unsaved'), updatedAt: 2 }]), false); }
    finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
      else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    }
    assert.equal(loadSavedFlows()[0].doc.name, 'Saved');
  });
});
