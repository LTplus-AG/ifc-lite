/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FLOW_STARTUP_KEY, readStartupFlowId, saveStartupFlowId, resolveStartupFlow, suppressStartupWorkflow } from './startup-preference';
import { newFlowDocument } from './persistence';

describe('startup workflow preference (#6612)', () => {
  it('defaults off, persists only a saved graph ID and resolves deletion safely', () => {
    localStorage.clear();
    assert.equal(readStartupFlowId(), null);
    const doc = newFlowDocument('Review');
    saveStartupFlowId(doc.id);
    assert.equal(readStartupFlowId(), doc.id);
    assert.equal(resolveStartupFlow([{ doc, updatedAt: 1 }], readStartupFlowId())?.doc.id, doc.id);
    assert.equal(resolveStartupFlow([], readStartupFlowId()), null);
    saveStartupFlowId(null);
    assert.equal(readStartupFlowId(), null);
  });
  it('ignores invalid versions/IDs and surfaces write failure', () => {
    for (const value of [{ version: 2, flowId: 'x' }, { version: 1, flowId: '' }, { version: 1, flowId: 123 }]) {
      localStorage.setItem(FLOW_STARTUP_KEY, JSON.stringify(value));
      assert.equal(readStartupFlowId(), null);
    }
    assert.throws(() => saveStartupFlowId('graph', { setItem() { throw new Error('Quota'); }, removeItem() {} }), /Quota/);
  });
  it('gives explicit model, collaboration and workflow startup links priority', () => {
    assert.equal(suppressStartupWorkflow('?lang=de'), false);
    for (const search of ['?model=https%3A%2F%2Fexample.org%2Fm.ifc', '?room=shared&t=token', '?tour=1', '?flow=graph']) {
      assert.equal(suppressStartupWorkflow(search), true);
    }
  });
});
