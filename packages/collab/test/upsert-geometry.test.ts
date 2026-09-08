/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit cover for `upsertGeometry`, the overlay-side counterpart to
 * `createGeometry`.
 *
 * These assert on the function directly rather than through
 * `mergeBranch('layer')`. That is deliberate: a merge applies a Yjs update, and
 * CRDT convergence can restore a field the callee wrongly cleared, so the merge
 * path cannot police what `upsertGeometry` leaves alone. Measured — a version
 * vector reset inside `upsertGeometry` is invisible end-to-end and caught here.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bumpGeometryVersion,
  createGeometry,
  getGeometry,
  upsertGeometry,
} from '../src/doc/geometry.js';
import { GEOMETRY_KEY } from '../src/doc/schema.js';

function docWithG1(): Y.Doc {
  const doc = new Y.Doc();
  createGeometry(doc, 'g1', {
    type: 'parametric',
    source: 'extruded-area-solid',
    blobHash: 'OLD',
    params: { a: 1, b: 2 },
    bbox: [0, 0, 0, 1, 1, 1],
  });
  return doc;
}

describe('upsertGeometry', () => {
  it('creates the record when absent, exactly as createGeometry would', () => {
    const doc = new Y.Doc();
    upsertGeometry(doc, 'g9', { type: 'mesh', source: 'mesh-blob', blobHash: 'H' });
    const node = getGeometry(doc, 'g9');
    expect(node?.get(GEOMETRY_KEY.BLOB_HASH)).toBe('H');
    // A created record still gets its version vector, or bumpGeometryVersion throws.
    expect(node?.get(GEOMETRY_KEY.VERSION_VECTOR)).toBeInstanceOf(Y.Map);
  });

  it('overwrites the fields the carrier supplies, type and source included', () => {
    const doc = docWithG1();
    // The re-mesh case: a branch converting a parametric solid to a mesh sends
    // a new type AND source. Asserting only blobHash lets an implementation
    // that never writes those two pass.
    upsertGeometry(doc, 'g1', { type: 'mesh', source: 'mesh-blob', blobHash: 'NEW' });
    const node = getGeometry(doc, 'g1');
    expect(node?.get(GEOMETRY_KEY.BLOB_HASH)).toBe('NEW');
    expect(node?.get(GEOMETRY_KEY.TYPE)).toBe('mesh');
    expect(node?.get(GEOMETRY_KEY.SOURCE)).toBe('mesh-blob');
  });

  it('merges params instead of replacing the map', () => {
    const doc = docWithG1();
    upsertGeometry(doc, 'g1', { type: 'parametric', source: 'extruded-area-solid', params: { b: 9, c: 3 } });
    const params = getGeometry(doc, 'g1')?.get(GEOMETRY_KEY.PARAMS) as Y.Map<unknown>;
    expect(params.get('a')).toBe(1); // untouched key survives
    expect(params.get('b')).toBe(9); // supplied key wins
    expect(params.get('c')).toBe(3); // new key lands
  });

  it('leaves an omitted field alone rather than clearing it', () => {
    const doc = docWithG1();
    upsertGeometry(doc, 'g1', { type: 'parametric', source: 'extruded-area-solid' });
    expect(getGeometry(doc, 'g1')?.get(GEOMETRY_KEY.BLOB_HASH)).toBe('OLD');
    expect(getGeometry(doc, 'g1')?.get(GEOMETRY_KEY.BBOX)).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it('does not touch the version vector', () => {
    const doc = docWithG1();
    bumpGeometryVersion(doc, 'g1', 'peer-a');
    upsertGeometry(doc, 'g1', { type: 'parametric', source: 'extruded-area-solid', blobHash: 'NEW' });
    const vv = getGeometry(doc, 'g1')?.get(GEOMETRY_KEY.VERSION_VECTOR) as Y.Map<number>;
    expect(vv.get('peer-a')).toBe(1);
  });
});
