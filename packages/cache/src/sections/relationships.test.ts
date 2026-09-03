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
import { RelationshipGraphBuilder, RelationshipType, edgeSurvives } from '@ifc-lite/data';
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';
import { readRelationships, writeRelationships } from './relationships.js';

/**
 * Hand-builds a relationships-section buffer with one forward node whose
 * `count` overruns the edge arrays, and an empty (but well-formed) inverse
 * half. Bypasses `writeRelationships`/`RelationshipGraphBuilder` so the
 * corruption is explicit and doesn't depend on the writer ever producing it.
 *
 * Both buffers below are v17-shaped (no shadowed-rel-ids trailer, #3782) —
 * `readRelationships` is called with `version: 17` so a v18+ reader doesn't
 * try to read a trailer these hand-built buffers never wrote.
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
    expect(() => readRelationships(reader, 17)).toThrow(/Corrupt cache RelationshipGraph/);
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
    const graph = readRelationships(reader, 17);
    const related = graph.getRelated(1, RelationshipType.ContainsElements, 'forward');
    expect(related).toEqual([42]);
  });
});

// Two schema-legal IfcRel* instances can name the same (relating, related)
// pair (#3760); RelationshipGraphBuilder.addEdge folds the repeat into the
// surviving edge's `shadowedRelationshipIds` (#3782) instead of dropping it.
// A cache round-trip must carry those ids too, or a delete of the surviving
// IfcRel* on a cache-loaded model erases a connection a sibling instance
// still names — the exact gap FORMAT_VERSION 18 closes.
describe('shadowed rel ids survive a cache round-trip (#3782)', () => {
  it('carries every collapsed IfcRel id through write/read at the current FORMAT_VERSION', () => {
    const builder = new RelationshipGraphBuilder();
    builder.addEdge(200, 301, RelationshipType.ContainsElements, 5001);
    builder.addEdge(200, 301, RelationshipType.ContainsElements, 5002); // redundant IfcRel
    builder.addEdge(200, 301, RelationshipType.ContainsElements, 5003); // and a third
    const graph = builder.build();

    const writer = new BufferWriter();
    writeRelationships(writer, graph);
    const reader = new BufferReader(writer.build());
    const roundTripped = readRelationships(reader);

    const edge = roundTripped.forward.getEdges(200, RelationshipType.ContainsElements)[0];
    expect(edge.relationshipId).toBe(5001);
    expect(edge.shadowedRelationshipIds).toEqual([5002, 5003]);

    const info = roundTripped.getRelationshipsBetween(200, 301);
    expect(info).toHaveLength(1);
    expect(info[0].shadowedRelationshipIds).toEqual([5002, 5003]);
  });

  it('keeps the connection alive when the surviving IfcRel is deleted but a shadowed sibling is not', () => {
    const builder = new RelationshipGraphBuilder();
    builder.addEdge(200, 301, RelationshipType.ContainsElements, 5001);
    builder.addEdge(200, 301, RelationshipType.ContainsElements, 5002);
    const graph = builder.build();

    const writer = new BufferWriter();
    writeRelationships(writer, graph);
    const reader = new BufferReader(writer.build());
    const roundTripped = readRelationships(reader);

    const edge = roundTripped.forward.getEdges(200, RelationshipType.ContainsElements)[0];
    expect(edgeSurvives(edge, (id) => id === 5001)).toBe(true); // 5002 still alive
    expect(edgeSurvives(edge, (id) => id === 5001 || id === 5002)).toBe(false); // both gone
  });

  it('reads a v17 (pre-#3782) section as having no shadowed ids, not as corrupt', () => {
    const builder = new RelationshipGraphBuilder();
    builder.addEdge(200, 301, RelationshipType.ContainsElements, 5001);
    builder.addEdge(200, 301, RelationshipType.ContainsElements, 5002);
    const graph = builder.build();

    // A real v18 writer always emits the trailer; simulate what a v17
    // cache blob looked like by hand-writing the pre-#3782 shape (only the
    // three original edge arrays), truncating the shadow id.
    const w = new BufferWriter();
    const writeHalf = (edges: typeof graph.forward) => {
      w.writeUint32(edges.offsets.size);
      for (const [entityId, offset] of edges.offsets) {
        w.writeUint32(entityId);
        w.writeUint32(offset);
        w.writeUint32(edges.counts.get(entityId) ?? 0);
      }
      w.writeUint32(edges.edgeTargets.length);
      w.writeTypedArray(edges.edgeTargets);
      w.writeTypedArray(edges.edgeTypes);
      w.writeTypedArray(edges.edgeRelIds);
    };
    writeHalf(graph.forward);
    writeHalf(graph.inverse);

    const reader = new BufferReader(w.build());
    const roundTripped = readRelationships(reader, 17);
    const edge = roundTripped.forward.getEdges(200, RelationshipType.ContainsElements)[0];
    expect(edge.relationshipId).toBe(5001);
    expect(edge.shadowedRelationshipIds).toBeUndefined();
  });
});

/**
 * `readEdges`'s v17 shadow-id trailer had the SAME gap the (offset, count)
 * guard above closed for the base edge arrays: `readUint32Array` bounds-
 * checks against the buffer's remaining bytes, not against whether the
 * VALUES it read are internally consistent. Probed against `getEdges`'s
 * `binarySearchU32` + `shadowedRelIds.subarray(...)` before the guard
 * existed: a non-ascending `shadowedEdgeIndex` attaches an id to the WRONG
 * edge and loses another; a `shadowedGroupOffsets` entry past the real
 * `shadowedRelIds` length silently clamps the slice; a `shadowedEdgeIndex`
 * entry past `edgeCount` makes the whole group unreachable (never found by
 * binary search, silently dropped); `shadowedGroupOffsets` not starting at
 * 0, or two equal neighbours (an empty group), corrupt the layout the same
 * way — all four are wrong data returned with no error, not a crash.
 */
describe('shadowed-rel-ids trailer corruption guard (#3782 round 3)', () => {
  /** One forward node (entityId=1) with two well-formed edges (targets 42,
   *  43; rel ids 100, 200) — a real edgeCount of 2 for the trailer to be
   *  validated against. Inverse half is empty and well-formed. The shadow
   *  trailer itself is exactly what `opts` supplies, unvalidated by this
   *  helper — the corruption under test. */
  function buildV17Buffer(opts: {
    shadowedEdgeIndex: number[];
    shadowedGroupOffsets: number[];
    shadowedRelIds: number[];
  }): ArrayBuffer {
    const w = new BufferWriter();
    w.writeUint32(1); // nodeCount
    w.writeUint32(1); // entityId
    w.writeUint32(0); // offset
    w.writeUint32(2); // count
    w.writeUint32(2); // edgeCount
    w.writeTypedArray(new Uint32Array([42, 43])); // edgeTargets
    w.writeTypedArray(new Uint16Array([RelationshipType.ContainsElements, RelationshipType.ContainsElements])); // edgeTypes
    w.writeTypedArray(new Uint32Array([100, 200])); // edgeRelIds
    w.writeUint32(opts.shadowedEdgeIndex.length);
    w.writeTypedArray(new Uint32Array(opts.shadowedEdgeIndex));
    w.writeTypedArray(new Uint32Array(opts.shadowedGroupOffsets));
    w.writeUint32(opts.shadowedRelIds.length);
    w.writeTypedArray(new Uint32Array(opts.shadowedRelIds));
    // inverse: empty, well-formed, zero-group trailer.
    w.writeUint32(0);
    w.writeUint32(0);
    w.writeUint32(0);
    w.writeTypedArray(new Uint32Array(0));
    w.writeTypedArray(new Uint32Array([0]));
    w.writeUint32(0);
    w.writeTypedArray(new Uint32Array(0));
    return w.build();
  }

  it('accepts a well-formed multi-group trailer (sanity check for the helper below)', () => {
    const buf = buildV17Buffer({
      shadowedEdgeIndex: [0, 1],
      shadowedGroupOffsets: [0, 1, 3],
      shadowedRelIds: [7001, 8001, 8002],
    });
    const reader = new BufferReader(buf);
    const graph = readRelationships(reader, 17);
    expect(graph.forward.getEdges(1, RelationshipType.ContainsElements)[0].shadowedRelationshipIds).toEqual([7001]);
    expect(graph.forward.getEdges(1, RelationshipType.ContainsElements)[1].shadowedRelationshipIds).toEqual([8001, 8002]);
  });

  it('rejects a non-ascending shadowedEdgeIndex (would attach an id to the wrong edge)', () => {
    const buf = buildV17Buffer({
      shadowedEdgeIndex: [1, 0],
      shadowedGroupOffsets: [0, 1, 2],
      shadowedRelIds: [7777, 8888],
    });
    expect(() => readRelationships(new BufferReader(buf), 17)).toThrow(/Corrupt cache RelationshipGraph/);
  });

  it('rejects a shadowedGroupOffsets tail that does not match shadowedRelIds.length (silent clamp)', () => {
    const buf = buildV17Buffer({
      shadowedEdgeIndex: [0],
      shadowedGroupOffsets: [0, 99],
      shadowedRelIds: [7777],
    });
    expect(() => readRelationships(new BufferReader(buf), 17)).toThrow(/Corrupt cache RelationshipGraph/);
  });

  it('rejects a shadowedEdgeIndex entry past edgeCount (the group becomes unreachable)', () => {
    const buf = buildV17Buffer({
      shadowedEdgeIndex: [99],
      shadowedGroupOffsets: [0, 1],
      shadowedRelIds: [7777],
    });
    expect(() => readRelationships(new BufferReader(buf), 17)).toThrow(/Corrupt cache RelationshipGraph/);
  });

  it('rejects shadowedGroupOffsets not starting at 0', () => {
    const buf = buildV17Buffer({
      shadowedEdgeIndex: [0],
      shadowedGroupOffsets: [1, 2],
      shadowedRelIds: [7777],
    });
    expect(() => readRelationships(new BufferReader(buf), 17)).toThrow(/Corrupt cache RelationshipGraph/);
  });

  it('rejects an empty group (two equal neighbouring offsets)', () => {
    const buf = buildV17Buffer({
      shadowedEdgeIndex: [0, 1],
      shadowedGroupOffsets: [0, 0, 1],
      shadowedRelIds: [7777],
    });
    expect(() => readRelationships(new BufferReader(buf), 17)).toThrow(/Corrupt cache RelationshipGraph/);
  });
});
