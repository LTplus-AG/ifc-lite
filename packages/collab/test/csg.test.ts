/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createCollabDoc } from '../src/doc/schema.js';
import {
  appendCSGOp,
  ensureCSGTree,
  getCSGOps,
  insertCSGOp,
  moveCSGOp,
  removeCSGOp,
  type CSGOp,
} from '../src/geometry/csg.js';

const op = (id: string, opName: 'union' | 'difference' | 'intersection' | 'xor' = 'union'): CSGOp => ({
  opId: id,
  op: opName,
  operandGeomId: `geom-${id}`,
});

describe('CSG-tree (Y.Array<CSGOp>)', () => {
  it('appends ops in order', () => {
    const doc = createCollabDoc();
    appendCSGOp(doc, 'shape', op('a'));
    appendCSGOp(doc, 'shape', op('b', 'difference'));
    appendCSGOp(doc, 'shape', op('c'));
    expect(getCSGOps(doc, 'shape').map((o) => o.opId)).toEqual(['a', 'b', 'c']);
  });

  it('removes by opId', () => {
    const doc = createCollabDoc();
    appendCSGOp(doc, 'shape', op('a'));
    appendCSGOp(doc, 'shape', op('b'));
    appendCSGOp(doc, 'shape', op('c'));
    expect(removeCSGOp(doc, 'shape', 'b')).toBe(true);
    expect(getCSGOps(doc, 'shape').map((o) => o.opId)).toEqual(['a', 'c']);
    expect(removeCSGOp(doc, 'shape', 'missing')).toBe(false);
  });

  it('inserts at index', () => {
    const doc = createCollabDoc();
    appendCSGOp(doc, 'shape', op('a'));
    appendCSGOp(doc, 'shape', op('c'));
    insertCSGOp(doc, 'shape', 1, op('b'));
    expect(getCSGOps(doc, 'shape').map((o) => o.opId)).toEqual(['a', 'b', 'c']);
  });

  it('moveCSGOp reorders', () => {
    const doc = createCollabDoc();
    appendCSGOp(doc, 'shape', op('a'));
    appendCSGOp(doc, 'shape', op('b'));
    appendCSGOp(doc, 'shape', op('c'));
    expect(moveCSGOp(doc, 'shape', 'a', 2)).toBe(true);
    expect(getCSGOps(doc, 'shape').map((o) => o.opId)).toEqual(['b', 'c', 'a']);
  });

  it('concurrent appends interleave deterministically across peers', () => {
    const a = createCollabDoc();
    const b = createCollabDoc();
    ensureCSGTree(a, 'shape');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    a.transact(() => appendCSGOp(a, 'shape', op('a-1')));
    b.transact(() => appendCSGOp(b, 'shape', op('b-1')));
    a.transact(() => appendCSGOp(a, 'shape', op('a-2')));

    const aSv = Y.encodeStateVector(a);
    const bSv = Y.encodeStateVector(b);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, bSv));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, aSv));

    const aOps = getCSGOps(a, 'shape').map((o) => o.opId);
    const bOps = getCSGOps(b, 'shape').map((o) => o.opId);
    expect(aOps).toEqual(bOps);
    expect(aOps).toContain('a-1');
    expect(aOps).toContain('a-2');
    expect(aOps).toContain('b-1');
  });
});
