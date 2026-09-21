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

  it('keeps a workerless frozen-frame hole owned before publishing a later source slot (#5161)', () => {
    const registry = new FederationRegistry();
    const published: number[] = [];
    const transaction = new LandXmlProvisionalTransaction('workerless-hole', 2, {
      originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
    }, registry, { publish: (entry) => { published.push(entry.expressId); }, remove: () => {} });
    transaction.skip(mesh(1));
    transaction.publish(mesh(2));
    transaction.commit();
    assert.deepEqual(published, [transaction.idOffset + 2]);
    assert.deepEqual(registry.fromGlobalId(transaction.idOffset + 1), { modelId: 'workerless-hole', expressId: 1 });
    assert.deepEqual(registry.fromGlobalId(transaction.idOffset + 2), { modelId: 'workerless-hole', expressId: 2 });
  });

  it('can roll back an already committed upload if final metadata installation fails (#5050)', () => {
    const registry = new FederationRegistry();
    const removed: number[][] = [];
    const transaction = new LandXmlProvisionalTransaction('late-failure', 1, {
      originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
    }, registry, { publish: () => {}, remove: (ids) => { removed.push([...ids]); } });
    const global = transaction.publish(mesh(1));
    transaction.commit();
    transaction.rollback();
    assert.deepEqual(removed, [[global]]);
    assert.equal(registry.fromGlobalId(global), null);
  });
});
