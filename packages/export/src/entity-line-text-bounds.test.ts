/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `StepExporter.entityLineText` — the byte range the incidental line readers
 * (`getPropertySetName`, `getPropertyIdsInSet`, …) decode.
 *
 * Two things were unpinned here, and they are different failures:
 *
 * 1. **The range's START.** Advancing `byteOffset` by one while leaving the
 *    end where it is — the record's line minus its leading `#` — passed all
 *    699 runnable tests in this package. Nothing any reader parses lives in
 *    the first byte: every pattern they run is either unanchored or anchored
 *    at `$`, and the express id is supplied by the caller rather than read
 *    out of the text. So no existing case can see the start move.
 *
 * 2. **Out-of-range refs.** `IfcSourceBytes.decodeUtf8` CLAMPS a range it
 *    cannot address, and a clamped window is still a window over real file
 *    bytes. The readers therefore answered from another record rather than
 *    answering nothing — see `source-ref-bounds.ts` for the measured account
 *    of both directions, which is not restated here.
 *
 * The fixtures below are built through `CompactEntityIndexBuilder`, the same
 * index the real producers build, rather than by mutating refs in place: a
 * `CompactEntityIndex` serves `EntityRef` objects out of an LRU over typed
 * arrays, so an in-place edit survives only until that entry is rebuilt.
 */

import { describe, expect, it } from 'vitest';
import {
  asSourceBytes,
  CompactEntityIndexBuilder,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { StepExporter } from './step-exporter.js';

/**
 * The private line readers, named. These are the unit under test: no PUBLIC
 * path is sensitive to the range's start (that is finding 1 above), so a
 * behavioural test alone cannot pin it.
 */
type LineReaders = {
  entityLineText(entityId: number): string | null;
  getPropertySetName(psetId: number): string | null;
  getPropertyIdsInSet(psetId: number): number[];
};

const SET_A = "#1=IFCPROPERTYSET('0setA0000000000000000',$,'SetA',$,(#101,#102));";
const SET_B = "#2=IFCPROPERTYSET('0setB0000000000000000',$,'SetB',$,(#201,#202));";

/**
 * A two-record source. `ranges` overrides an entity's `(byteOffset,
 * byteLength)` to model a corrupt index over an intact file.
 */
function storeOf(ranges?: Map<number, [number, number]>): IfcDataStore {
  const encoder = new TextEncoder();
  const lines: Array<[number, string, string]> = [
    [1, 'IFCPROPERTYSET', SET_A],
    [2, 'IFCPROPERTYSET', SET_B],
  ];
  const builder = new CompactEntityIndexBuilder(lines.length);
  const byType = new Map<string, number[]>();
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (const [id, type, text] of lines) {
    const encoded = encoder.encode(text);
    const range = ranges?.get(id) ?? [offset, encoded.byteLength];
    builder.add(id, type, range[0], range[1]);
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type)!.push(id);
    parts.push(encoded);
    offset += encoded.byteLength;
  }

  const source = new Uint8Array(offset);
  let position = 0;
  for (const part of parts) {
    source.set(part, position);
    position += part.byteLength;
  }

  return {
    fileSize: offset,
    schemaVersion: 'IFC4',
    entityCount: lines.length,
    parseTime: 0,
    source: asSourceBytes(source),
    entityIndex: { byId: builder.build(), byType },
  } as unknown as IfcDataStore;
}

function readersOf(ranges?: Map<number, [number, number]>): LineReaders {
  return new StepExporter(storeOf(ranges)) as unknown as LineReaders;
}

describe('entityLineText byte range', () => {
  /**
   * The START pin. `entityLineText` must decode the record's line from its
   * FIRST byte, and the only assertion that can see that is one over the
   * whole decoded text — hence the equality rather than a reader's answer.
   *
   * RED on `byteOffset + 1` (start advanced, end left alone), the mutation
   * that otherwise passes every test in the package.
   */
  it('decodes the record from its first byte, not one byte in', () => {
    const readers = readersOf();
    expect(readers.entityLineText(1)).toBe(SET_A);
    expect(readers.entityLineText(2)).toBe(SET_B);
  });

  /**
   * The END pin, stated as the answer rather than the text: `#1`'s member
   * list is `#1`'s, whatever the window does past its close.
   */
  it("reads a mid-file record's own member list, not the next record's", () => {
    expect(readersOf().getPropertyIdsInSet(1)).toEqual([101, 102]);
  });

  /**
   * An overrunning END is NOT benign. `(0, 9999)` for `#1` clamps to EOF, so
   * the `$`-anchored member-list pattern matches at the end of the CLAMPED
   * window — the file's last record. Before the readers were gated on
   * `isReadableSourceRef` this returned `[201, 202]`, `#2`'s members, and
   * `retainSharedAtoms` un-skipped them on `#1`'s behalf.
   */
  it('answers nothing for a ref whose end runs past the source', () => {
    const readers = readersOf(new Map([[1, [0, 9999]]]));
    expect(readers.getPropertyIdsInSet(1)).toEqual([]);
    expect(readers.getPropertySetName(1)).toBeNull();
    expect(readers.entityLineText(1)).toBeNull();
  });

  /**
   * The same for the file's LAST record, where the clamp happened to land on
   * exactly the right text and the old answer was right by luck. The
   * source-iteration pass drops such a record anyway (`isReadableSourceRef`),
   * so an answer here only made the two passes disagree.
   */
  it('answers nothing for an overrunning ref on the last record too', () => {
    const readers = readersOf(new Map([[2, [SET_A.length, 9999]]]));
    expect(readers.getPropertySetName(2)).toBeNull();
    expect(readers.getPropertyIdsInSet(2)).toEqual([]);
  });

  /**
   * A ref starting before the source. This one is green on `main` too, and
   * for a reason worth recording rather than for the gate: `CompactEntityIndex`
   * keeps offsets in a `Uint32Array`, so `-2` comes back out as 4294967294 and
   * is out of range at the far end instead. A negative offset is not
   * representable through the index these readers consult — which is why the
   * REACHABLE bad shape is the overrun above, not this one. Over a plain-`Map`
   * index (the test doubles in `sourceless-store-export.test.ts`) `-2` survives
   * as `-2`, floors to 0, and used to name `#2` `'SetA'`; the gate rejects that
   * too.
   */
  it('answers nothing for a ref that starts before the source', () => {
    const readers = readersOf(new Map([[2, [-2, SET_A.length]]]));
    expect(readers.getPropertySetName(2)).toBeNull();
  });

  /** A zero-length ref is the canonical "no source line" marker. */
  it('answers nothing for a zero-length ref', () => {
    expect(readersOf(new Map([[1, [0, 0]]])).entityLineText(1)).toBeNull();
  });
});
