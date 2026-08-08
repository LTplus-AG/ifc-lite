/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildParseReply, buildProfilesReply } from './reply.js';
import { createEmptyFlatProfiles } from './profiles-flat.js';

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

describe('buildProfilesReply', () => {
  it('transfers every non-empty buffer exactly once', () => {
    const flat = createEmptyFlatProfiles();
    flat.expressId = new Uint32Array([7, 8]);
    flat.outerPoints = new Float32Array([0, 0, 1, 1]);
    // Two views over ONE buffer: transferring it twice throws, so the reply
    // builder must de-duplicate by buffer identity.
    const shared = new Float32Array([1, 2, 3, 4, 5, 6]);
    flat.transform = shared.subarray(0, 3);
    flat.extrusionDir = shared.subarray(3, 6);

    const { reply, transfer } = buildProfilesReply(3, flat);
    assert.equal(reply.id, 3);
    assert.equal(reply.ok, true);
    assert.equal(new Set(transfer).size, transfer.length, 'no buffer may appear twice');
    assert.ok(transfer.includes(flat.expressId.buffer as ArrayBuffer));
    assert.ok(transfer.includes(shared.buffer as ArrayBuffer));
    // expressId, outerPoints, the one shared transform/extrusionDir buffer, and
    // the three `N + 1` offset arrays (each holds its leading zero, so each is
    // non-empty). Everything else on an empty flatten is zero-length.
    assert.equal(transfer.length, 6);
  });

  // A model with no openings genuinely produces empty hole arrays every time.
  // Transferring one detaches it, and the next reply from the same worker
  // throws DataCloneError, surfacing as a parse failure.
  it('never transfers a zero-length buffer, and skips the string table', () => {
    const flat = createEmptyFlatProfiles();
    flat.typeNames = ['IfcWall'];
    const { transfer } = buildProfilesReply(1, flat);
    assert.deepEqual(
      transfer.filter((b) => b.byteLength === 0),
      [],
      'nothing to move, and moving it invites detachment',
    );
    // `createEmptyFlatProfiles` is all-empty apart from the `N + 1` offset
    // arrays, which each hold one leading zero.
    assert.equal(transfer.length, 3, 'the three offset arrays, and nothing else');
  });
});
