/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildParseReply } from './reply.js';

describe('buildParseReply', () => {
  it('passes real vertices through and transfers their buffer', () => {
    const verts = new Float32Array([0, 0, 0, 1, 2, 3]);
    const { reply, transfer } = buildParseReply(7, verts);
    assert.equal(reply.id, 7);
    assert.equal(reply.ok, true);
    assert.equal(reply.ok && reply.verts, verts);
    assert.deepEqual(transfer, [verts.buffer]);
  });

  it('never transfers a zero-length buffer', () => {
    const { transfer } = buildParseReply(1, new Float32Array(0));
    assert.deepEqual(transfer, [], 'nothing to move, and transferring it invites detachment');
  });

  it('normalises null and empty results to a fresh array', () => {
    for (const input of [null, undefined, new Float32Array(0)]) {
      const { reply } = buildParseReply(1, input);
      assert.equal(reply.ok, true);
      assert.equal(reply.ok && reply.verts.length, 0);
    }
  });

  // The bug: a shared module-level empty array, transferred once, is detached
  // for every later reply from the same worker, which then throws
  // DataCloneError and surfaces as a parse failure.
  it('gives each no-result reply a DISTINCT buffer', () => {
    const first = buildParseReply(1, null);
    const second = buildParseReply(2, new Float32Array(0));
    assert.ok(first.reply.ok && second.reply.ok);
    assert.notEqual(
      first.reply.ok && first.reply.verts.buffer,
      second.reply.ok && second.reply.verts.buffer,
      'two empty replies from one worker must not share a buffer',
    );
  });
});
