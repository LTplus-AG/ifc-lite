/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `readEdges`'s per-node (offset, count) pair is a field independent of
 * `edgeCount` (see the doc comment in relationships.ts). Nothing validated it
 * against the actual edge-array length, so a cache file whose directory got
 * corrupted between write and read (disk bitrot, a truncated/partial write, a
 * hand-edited or malicious file) silently returned edges with `undefined`
 * target/type/relationshipId mixed in with the real ones, instead of failing
 * loudly the way every sibling section (StringTable offsets, entity-index
 * typeIndex, InstancedShards) already does on the equivalent corruption.
 */

import { describe, it, expect } from 'vitest';
import { RelationshipType } from '@ifc-lite/data';
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';
import { readRelationships } from './relationships.js';

/**
 * Hand-builds a relationships-section buffer with one forward node whose
 * `count` overruns the edge arrays, and an empty (but well-formed) inverse
 * half. Bypasses `writeRelationships`/`RelationshipGraphBuilder` so the
 * corruption is explicit and doesn't depend on the writer ever producing it.
 */
function buildCorruptBuffer(): ArrayBuffer {
  const w = new BufferWriter();

  // --- forward: 1 node, entityId=1, offset=0, count=5, but only 1 real edge.
  w.writeUint32(1); // nodeCount
  w.writeUint32(1); // entityId
  w.writeUint32(0); // offset
  w.writeUint32(5); // count -- overruns edgeCount below
  w.writeUint32(1); // edgeCount
  w.writeTypedArray(new Uint32Array([42])); // edgeTargets
  w.writeTypedArray(new Uint16Array([RelationshipType.ContainsElements])); // edgeTypes
  w.writeTypedArray(new Uint32Array([100])); // edgeRelIds

  // --- inverse: empty, well-formed.
  w.writeUint32(0); // nodeCount
  w.writeUint32(0); // edgeCount

  return w.build();
}

describe('RelationshipGraph corrupt-cache guard', () => {
  it('rejects a node whose (offset, count) range exceeds the edge array length', () => {
    const reader = new BufferReader(buildCorruptBuffer());
    expect(() => readRelationships(reader)).toThrow(/Corrupt cache RelationshipGraph/);
  });

  it('still accepts a well-formed graph whose ranges fit', () => {
    const w = new BufferWriter();
    // forward: 1 node, entityId=1, offset=0, count=1 -- exactly fits.
    w.writeUint32(1);
    w.writeUint32(1);
    w.writeUint32(0);
    w.writeUint32(1);
    w.writeUint32(1);
    w.writeTypedArray(new Uint32Array([42]));
    w.writeTypedArray(new Uint16Array([RelationshipType.ContainsElements]));
    w.writeTypedArray(new Uint32Array([100]));
    // inverse: empty.
    w.writeUint32(0);
    w.writeUint32(0);

    const reader = new BufferReader(w.build());
    const graph = readRelationships(reader);
    const related = graph.getRelated(1, RelationshipType.ContainsElements, 'forward');
    expect(related).toEqual([42]);
  });
});
