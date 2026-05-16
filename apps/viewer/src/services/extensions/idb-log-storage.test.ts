/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { ActionEvent, AuditEvent } from '@ifc-lite/extensions';
import { IdbLogStorage } from './idb-log-storage.js';

function actionEvent(seq: number, intent: ActionEvent['intent'] = 'model.unload'): ActionEvent {
  return {
    seq,
    ts: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    intent,
    params: {} as ActionEvent['params'],
    success: true,
  } as ActionEvent;
}

function auditEvent(seq: number, id: string = 'com.example.ext'): AuditEvent {
  return {
    seq,
    ts: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    kind: 'install',
    extensionId: id,
    version: '1.0.0',
    grantedCapabilities: [],
  } as AuditEvent;
}

const FLUSH_WAIT_MS = 400; // debounce is 250 ms; wait a bit longer.

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('IdbLogStorage', () => {
  beforeEach(async () => {
    const store = new IdbLogStorage();
    await store.clearActions();
    await store.clearAudit();
  });

  it('round-trips action events through debounced writes', async () => {
    const store = new IdbLogStorage();
    store.appendAction(actionEvent(1));
    store.appendAction(actionEvent(2));
    store.appendAction(actionEvent(3));
    await sleep(FLUSH_WAIT_MS);
    const loaded = await store.loadActions();
    assert.strictEqual(loaded.length, 3);
    assert.deepStrictEqual(loaded.map((e) => e.seq).sort((a, b) => a - b), [1, 2, 3]);
  });

  it('round-trips audit events', async () => {
    const store = new IdbLogStorage();
    store.appendAudit(auditEvent(1));
    store.appendAudit(auditEvent(2));
    await sleep(FLUSH_WAIT_MS);
    const loaded = await store.loadAudit();
    assert.strictEqual(loaded.length, 2);
  });

  it('clearActions wipes the action store but leaves audit alone', async () => {
    const store = new IdbLogStorage();
    store.appendAction(actionEvent(1));
    store.appendAudit(auditEvent(1));
    await sleep(FLUSH_WAIT_MS);
    await store.clearActions();
    assert.strictEqual((await store.loadActions()).length, 0);
    assert.strictEqual((await store.loadAudit()).length, 1);
  });

  it('clearAudit wipes the audit store but leaves actions alone', async () => {
    const store = new IdbLogStorage();
    store.appendAction(actionEvent(1));
    store.appendAudit(auditEvent(1));
    await sleep(FLUSH_WAIT_MS);
    await store.clearAudit();
    assert.strictEqual((await store.loadAudit()).length, 0);
    assert.strictEqual((await store.loadActions()).length, 1);
  });

  it('debounces a burst into one flush', async () => {
    const store = new IdbLogStorage();
    // Append 20 events in a tight loop — all should land after one
    // debounce window expires.
    for (let i = 1; i <= 20; i++) {
      store.appendAction(actionEvent(i));
    }
    // Before the debounce fires nothing is in storage yet.
    assert.strictEqual((await store.loadActions()).length, 0);
    await sleep(FLUSH_WAIT_MS);
    assert.strictEqual((await store.loadActions()).length, 20);
  });

  it('preserves the seq-based key uniqueness', async () => {
    const store = new IdbLogStorage();
    // Re-appending the same seq overwrites (keyPath: 'seq').
    store.appendAction({ ...actionEvent(1), params: { type: 'foo' } as ActionEvent['params'] });
    await sleep(FLUSH_WAIT_MS);
    store.appendAction({ ...actionEvent(1), params: { type: 'bar' } as ActionEvent['params'] });
    await sleep(FLUSH_WAIT_MS);
    const loaded = await store.loadActions();
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual((loaded[0].params as { type?: string }).type, 'bar');
  });
});
