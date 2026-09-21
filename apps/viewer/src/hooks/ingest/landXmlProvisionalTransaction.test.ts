/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FederationRegistry } from '@ifc-lite/renderer';
import { LandXmlProvisionalTransaction } from './landXmlProvisionalTransaction.js';

function mesh(expressId: number) {
  return {
    expressId, positions: new Float32Array([0, 0, 0]), normals: new Float32Array([0, 1, 0]),
    indices: new Uint32Array([0, 0, 0]), color: [0.42, 0.62, 0.32, 1] as [number, number, number, number], origin: [0, 0, 0] as [number, number, number],
  };
}

describe('LandXML provisional publication transaction (#5050)', () => {
  it('reserves IDs before source-order pickable publication and removes them on rollback', () => {
    const registry = new FederationRegistry();
    const published: number[] = [];
    const removed: number[][] = [];
    const transaction = new LandXmlProvisionalTransaction('landxml', 2, {
      originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
    }, registry, {
      publish: (entry) => { published.push(entry.expressId); },
      remove: (ids) => { removed.push([...ids]); },
    });
    assert.equal(registry.fromGlobalId(transaction.idOffset + 1), null, 'reservation alone is not pickable');
    assert.equal(transaction.publish(mesh(1)), transaction.idOffset + 1);
    assert.deepEqual(registry.fromGlobalId(transaction.idOffset + 1), { modelId: 'landxml', expressId: 1 });
    assert.throws(() => transaction.publish(mesh(3)), /ordering/);
    transaction.rollback();
    assert.deepEqual(published, [transaction.idOffset + 1]);
    assert.deepEqual(removed, [[transaction.idOffset + 1]]);
    assert.equal(registry.fromGlobalId(transaction.idOffset + 1), null);
  });

  it('rejects a short second pass rather than committing a partial model', () => {
    const registry = new FederationRegistry();
    let removed = 0;
    const transaction = new LandXmlProvisionalTransaction('short', 2, {
      originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
    }, registry, { publish: () => {}, remove: () => { removed++; } });
    transaction.publish(mesh(1));
    assert.throws(() => transaction.commit(), /did not reproduce/);
    assert.equal(removed, 1);
    assert.equal(registry.getOffset('short'), null);
  });
});
