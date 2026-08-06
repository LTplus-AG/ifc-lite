/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildParseReply } from './reply.js';

/** Narrow the widened response union to the line-parse arm. */
function verts(reply: { ok: boolean } & Record<string, unknown>): Float32Array {
  if (!('verts' in reply)) throw new Error('expected a line-parse reply');
  return reply.verts as Float32Array;
}

describe('buildParseReply', () => {
  it('passes real vertices through and transfers their buffer', () => {
    const vertsIn = new Float32Array([0, 0, 0, 1, 2, 3]);
    const { reply, transfer } = buildParseReply(7, vertsIn);
    assert.equal(reply.id, 7);
    assert.equal(reply.ok, true);
    assert.equal(verts(reply), vertsIn);
    assert.deepEqual(transfer, [vertsIn.buffer]);
  });

  it('never transfers a zero-length buffer', () => {
    const { transfer } = buildParseReply(1, new Float32Array(0));
    assert.deepEqual(transfer, [], 'nothing to move, and transferring it invites detachment');
  });

  it('normalises null and empty results to a fresh array', () => {
    for (const input of [null, undefined, new Float32Array(0)]) {
      const { reply } = buildParseReply(1, input);
      assert.equal(reply.ok, true);
      assert.equal(verts(reply).length, 0);
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
      verts(first.reply).buffer,
      verts(second.reply).buffer,
      'two empty replies from one worker must not share a buffer',
    );
  });
});
