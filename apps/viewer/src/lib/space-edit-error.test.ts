/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { editError } from './space-edit-error.js';

describe('editError', () => {
  it('reads the stable code from a typed engine Error (name + message)', () => {
    const e = new Error('this wall bridges the room to itself');
    e.name = 'BridgeEdge';
    const r = editError(e);
    assert.strictEqual(r.code, 'BridgeEdge');
    assert.strictEqual(r.message, 'this wall bridges the room to itself');
  });

  it('returns code=null for an Error whose name is not a known edit code', () => {
    const e = new Error('boom'); // default name === 'Error'
    const r = editError(e);
    assert.strictEqual(r.code, null);
    assert.strictEqual(r.message, 'boom');
  });

  it('falls back to the name when an Error has no message', () => {
    const e = new Error('');
    e.name = 'StaleHandle';
    const r = editError(e);
    assert.strictEqual(r.code, 'StaleHandle');
    assert.strictEqual(r.message, 'StaleHandle');
  });

  it('strips a legacy "Code:" prefix from a thrown string', () => {
    const r = editError('BordersExterior: nothing to merge');
    assert.strictEqual(r.code, null);
    assert.strictEqual(r.message, 'nothing to merge');
  });

  it('handles a bare non-error value', () => {
    assert.strictEqual(editError(undefined).message, 'undefined');
    assert.strictEqual(editError(undefined).code, null);
  });
});
