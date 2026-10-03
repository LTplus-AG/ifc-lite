// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const assert = require('node:assert/strict');
const dir = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
let stages = 0, nativeWitnesses = 0;
for (const entry of manifest) {
  const bytes = gunzipSync(fs.readFileSync(path.join(dir, entry.receipt)));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.receiptSHA256);
  const receipt = JSON.parse(bytes);
  assert.deepEqual(receipt.source, entry.source);
  assert.equal(receipt.source.dirty, '');
  assert.equal(receipt.count, entry.models);
  assert.equal(receipt.proofs.length, entry.stages);
  assert.ok(receipt.wasmResponses.some(response => response.sha256 === receipt.source.wasmSHA256 && response.status === 200));
  assert.ok(receipt.calls.every(call => !call.reply.error));
  const peer = receipt.proofs[0].models.filter(model => model.modelId !== receipt.modelId);
  assert.equal(peer.length, entry.models - 1);
  for (const proof of receipt.proofs) {
    assert.deepEqual(proof.models.filter(model => model.modelId !== receipt.modelId), peer);
    const target = proof.models.find(model => model.modelId === receipt.modelId);
    assert.ok(target);
    for (const native of target.sourceNative?.bounds ?? []) {
      const shown = target.displayedBounds.find(box => box.id === native.id);
      assert.ok(shown);
      assert.equal(shown.triangles, native.triangles);
      assert.equal(shown.vertices, native.vertices);
      assert.ok(native.triangles > 0 && native.vertices > 0);
      for (const edge of ['min', 'max']) for (let axis = 0; axis < 3; axis++) {
        assert.ok(Number.isFinite(native[edge][axis]) && Number.isFinite(shown[edge][axis]));
        assert.ok(Math.abs(native[edge][axis] - shown[edge][axis]) < 1e-4);
      }
      nativeWitnesses++;
    }
    stages++;
  }
}
assert.equal(manifest.length, 6);
console.log(JSON.stringify({ receipts: manifest.length, stages, nativeWitnesses, verdict: 'All archived captured runtime hashes, native/displayed counts/bounds and complete peer states agree' }, null, 2));
