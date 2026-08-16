/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * github.com/LTplus-AG/ifc-lite/issues/2491: "an empty source implies
 * zero-length entity refs" was an UNSTATED invariant, and the exporter's
 * source-presence checks were sound only because of it.
 *
 * The hostile shape is a store whose `source` carries no bytes while its entity
 * index still describes real byte ranges. `willBeEmitted` answered YES for the
 * wall (its ref has `byteLength > 0`, which is the only thing that predicate
 * asked), the property-set generator therefore wrote an
 * `IfcRelDefinesByProperties` naming `#8`, and the source-iteration pass emitted
 * the wall's own line as the EMPTY STRING, because `decodeUtf8` clamps a range
 * it cannot address. The result was a silent dangling reference: a relationship
 * naming a wall whose line had vanished. No error, no warning.
 *
 * It is not reachable from any producer in this repo today — the one source-less
 * store builder (`apps/viewer/src/utils/serverDataModel.ts`) adds every ref as
 * `(0, 0)`. That is exactly what makes it worth pinning: the guarantee lived in
 * a producer nobody is obliged to read, and the repo has already shipped one
 * thing that bends this area (the source accessor of #2339/#2360, which
 * deliberately keeps `byteLength` so presence-style guards pass).
 *
 * ## The direction taken
 *
 * The issue offered two: assert the invariant where stores are constructed, or
 * stop relying on it. This takes the second. The exporter now tests the REF it
 * is about to read — is this byte range inside the source it would be read
 * from — rather than the source's presence. That degrades a violating store to
 * the shape the exporter already handles correctly (a record with no emittable
 * bytes: nothing may be generated FOR it, and nothing that names it is
 * written), instead of trusting a promise made somewhere else. An assertion at
 * construction would still leave every FUTURE producer — a partial or streaming
 * source, a store that attaches bytes after the fact — free to bypass it,
 * because there is no single chokepoint where stores are built.
 */

import { describe, expect, it } from 'vitest';
import {
  IfcParser,
  CompactEntityIndexBuilder,
  EMPTY_SOURCE_BYTES,
  asSourceBytes,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, OVERLAY_BYTE_OFFSET } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';
import { createSourceRefReader } from './source-ref-bounds.js';
import { getEffectiveEntityIndex } from './effective-index.js';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const WALL_ID = 8;

const BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-08-08T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#8=IFCWALL('0OSuGGYUFyIf0LtE29OSuH',$,'Existing Wall',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

async function parseBase(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(BASE_IFC)));
}

/** Every `#id=CLASS(...)` defining line in the DATA section. */
function dataEntityLines(stepText: string): string[] {
  const start = stepText.indexOf('DATA;') + 'DATA;'.length;
  const data = stepText.slice(start, stepText.indexOf('ENDSEC;', start));
  return data.split('\n').map((l) => l.trim()).filter((l) => /^#\d+\s*=/.test(l));
}

/** Every `#id` a line REFERENCES, ignoring its own defining id. */
function referencedIds(line: string): number[] {
  const body = line.slice(line.indexOf('='));
  return [...body.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
}

/**
 * A source-LESS copy of `store`, with its entity index rebuilt through the same
 * `CompactEntityIndexBuilder` the real source-less producer uses
 * (`apps/viewer/src/utils/serverDataModel.ts`).
 *
 * `keepRanges` is the invariant: `false` reproduces that producer exactly
 * (every ref `(0, 0)`), `true` is the violating shape — real byte ranges over a
 * source that has no bytes to serve them, which is what a producer attaching
 * bytes late or streaming a partial source would build.
 *
 * Rebuilding the index rather than mutating the refs in place matters:
 * `CompactEntityIndex` serves `EntityRef` objects out of an LRU over typed
 * arrays, so an edit to a returned ref survives only until that entry is
 * rebuilt — a fixture written that way tests whatever the cache happened to
 * hold.
 */
function sourceless(store: IfcDataStore, keepRanges: boolean): IfcDataStore {
  const builder = new CompactEntityIndexBuilder(store.entityIndex.byId.size);
  for (const [id, ref] of store.entityIndex.byId) {
    builder.add(id, ref.type, keepRanges ? ref.byteOffset : 0, keepRanges ? ref.byteLength : 0);
  }
  const copy = Object.create(Object.getPrototypeOf(store) as object) as IfcDataStore;
  Object.assign(copy, store);
  // `EMPTY_SOURCE_BYTES` rather than a bare `new Uint8Array(0)`: `source` is an
  // `IfcSourceBytes` accessor (#2339), and it is that accessor's `decodeUtf8`
  // whose CLAMPING is the whole mechanism under test. A raw typed array would
  // type-error and, worse, would not be the thing that clamps — the fixture has
  // to reach the real reader for the reproduction to mean anything.
  (copy as { source: IfcDataStore['source'] }).source = EMPTY_SOURCE_BYTES;
  (copy as { entityIndex: IfcDataStore['entityIndex'] }).entityIndex = {
    ...store.entityIndex,
    byId: builder.build(),
  };
  return copy;
}

describe('createSourceRefReader', () => {
  const readable = createSourceRefReader({ byteLength: 100 });

  it('accepts a range fully inside the source, last byte included', () => {
    expect(readable({ byteOffset: 0, byteLength: 10 })).toBe(true);
    expect(readable({ byteOffset: 90, byteLength: 10 })).toBe(true);
  });

  it('rejects a range that runs one byte past the end', () => {
    // The off-by-one that decides whether the last record in a file reads.
    expect(readable({ byteOffset: 91, byteLength: 10 })).toBe(false);
  });

  it('rejects the no-source-line markers', () => {
    expect(readable({ byteOffset: 0, byteLength: 0 })).toBe(false);
    expect(readable({ byteOffset: -1, byteLength: 20 })).toBe(false);
    expect(readable(undefined)).toBe(false);
  });

  it('reads nothing out of an absent or empty source', () => {
    expect(createSourceRefReader(null)({ byteOffset: 0, byteLength: 10 })).toBe(false);
    expect(createSourceRefReader({ byteLength: 0 })({ byteOffset: 0, byteLength: 10 })).toBe(false);
  });
});

describe('the exporter never writes a reference to a line it could not emit', () => {
  it('a store whose refs outrun its source emits no dangling reference', async () => {
    const store = sourceless(await parseBase(), true);
    // The violating shape, asserted rather than assumed: real range, no bytes.
    expect(store.entityIndex.byId.get(WALL_ID)!.byteLength).toBeGreaterThan(0);
    expect(store.source.byteLength).toBe(0);

    const view = new MutablePropertyView(null, 'test-model');
    view.setProperty(WALL_ID, 'Pset_New', 'IsExternal', true);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);
    const lines = dataEntityLines(text);

    // The defect: an IfcRelDefinesByProperties naming #8, whose own line was
    // written as the EMPTY STRING. Assert the FILE's closure rather than the
    // absence of one class — every id any emitted line names must itself be
    // defined by an emitted line.
    const defined = new Set(lines.map((l) => Number(/^#(\d+)/.exec(l)![1])));
    const dangling = lines.flatMap(referencedIds).filter((id) => !defined.has(id));
    expect(dangling).toEqual([]);
    // ...and the wall, whose bytes cannot be read, is simply not in the file
    // rather than in it as a blank line.
    expect(defined.has(WALL_ID)).toBe(false);
    // The blank lines themselves: the DATA section carries no empty record.
    const dataStart = text.indexOf('DATA;') + 'DATA;'.length;
    const data = text.slice(dataStart, text.indexOf('ENDSEC;', dataStart));
    expect(data.split('\n').filter((l) => l.trim() === '' ).length).toBeLessThanOrEqual(2);
  });

  it('the SAME session against the intact store still writes the pset and its relationship', async () => {
    // The bounding control. Refusing to read an out-of-range ref must not
    // refuse an in-range one: this is the ordinary path, and it has to keep
    // emitting the wall, the property set and the relationship that joins them.
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    view.setProperty(WALL_ID, 'Pset_New', 'IsExternal', true);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);
    const lines = dataEntityLines(text);

    const defined = new Set(lines.map((l) => Number(/^#(\d+)/.exec(l)![1])));
    expect(defined.has(WALL_ID)).toBe(true);
    expect(text).toContain('IFCPROPERTYSET');
    const rel = lines.find((l) => l.includes('IFCRELDEFINESBYPROPERTIES'));
    expect(rel).toBeDefined();
    expect(referencedIds(rel!)).toContain(WALL_ID);
    expect(lines.flatMap(referencedIds).filter((id) => !defined.has(id))).toEqual([]);
  });

  it('a source-less store whose refs ARE zero-length is untouched', async () => {
    // The shape the one real source-less producer builds (every ref `(0,0)`).
    // It was already handled and must stay handled: nothing is generated for a
    // host with no emittable line, and no relationship names it.
    const store = sourceless(await parseBase(), false);

    const view = new MutablePropertyView(null, 'test-model');
    view.setProperty(WALL_ID, 'Pset_New', 'IsExternal', true);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);
    const lines = dataEntityLines(text);
    const defined = new Set(lines.map((l) => Number(/^#(\d+)/.exec(l)![1])));

    expect(lines.flatMap(referencedIds).filter((id) => !defined.has(id))).toEqual([]);
  });
});

/**
 * Pins the exemption `source-ref-bounds.ts` grants the incidental readers
 * (`getPropertySetName`, `getElementQuantityName`, `getRelatedEntities`, …),
 * which decode a range and pattern-match in it rather than gating on
 * `createSourceRefReader`.
 *
 * The doc used to justify that with "a clamped, empty decode already yields no
 * match, which is the same answer". Measured below, that reason is wrong: a
 * clamped decode is only EMPTY when the range ends at or before byte 0. A
 * NEGATIVE offset with a positive length clamps its start up to 0 and decodes
 * the beginning of the file — a confidently wrong answer, not a null.
 *
 * The exemption is still correct, for a different and stronger reason, pinned
 * here so a future producer cannot quietly invalidate it: no negative offset
 * reaches those readers at all.
 */
describe('the incidental readers are exempt by construction, not by clamping', () => {
  it('a negative offset with a positive length decodes the WRONG line, not the empty string', () => {
    // The mechanism, isolated: `clampRange` floors the start at 0.
    const text = '#1=IFCPROPERTYSET(\'g1\',$,\'FirstName\',$,());\n#2=IFCPROPERTYSET(\'g2\',$,\'SecondName\',$,());\n';
    const bytes = asSourceBytes(new TextEncoder().encode(text));
    const secondOffset = text.indexOf('#2=');

    // The zero-length marker every real negative-offset producer writes: the
    // range ends at or before 0, so the decode really is empty and "no match"
    // really is the outcome the doc described.
    expect(bytes.decodeUtf8(-1, -1 + 0)).toBe('');

    // A negative offset with real length is a different animal. Asking for
    // `#2`'s line two bytes early does not fail — it returns `#1`'s.
    const wrong = bytes.decodeUtf8(-2, -2 + secondOffset);
    expect(wrong).not.toBe('');
    expect(wrong.match(/IFCPROPERTYSET\s*\([^,]*,[^,]*,'([^']*)'/i)![1]).toBe('FirstName');
  });

  it('every negative-offset producer pairs it with a zero byteLength', async () => {
    // `OVERLAY_BYTE_OFFSET` is the only negative offset in the repo. All three
    // sites that write it — `store-editor.ts` `addEntity`, and
    // `effective-index.ts` `get` / `[Symbol.iterator]` — pair it with
    // `byteLength: 0`, which is the case the clamp really does answer as empty.
    // All three are asserted here: the safety argument for the incidental
    // readers rests on the whole set, so pinning one and leaving the other two
    // to prose is how a future edit at an unpinned site goes unnoticed.
    expect(OVERLAY_BYTE_OFFSET).toBeLessThan(0);
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    const created = new StoreEditor(store, view)
      .addEntity('IFCWALL', [null, null, null, null, null, null, null, null]);

    // 1. `store-editor.ts` `addEntity`, the ref it hands back to its caller.
    expect(created.byteOffset).toBe(OVERLAY_BYTE_OFFSET);
    expect(created.byteLength).toBe(0);

    // The overlay is non-empty, so this is the `OverlayIndex` branch — the only
    // one of the two `getEffectiveEntityIndex` returns that synthesises a ref
    // for an overlay-created id at all.
    const effective = getEffectiveEntityIndex(store, view, true);

    // 2. `effective-index.ts` `get`.
    const fromGet = effective.get(created.expressId);
    expect(fromGet).toBeDefined();
    expect(fromGet!.byteOffset).toBe(OVERLAY_BYTE_OFFSET);
    expect(fromGet!.byteLength).toBe(0);

    // 3. `effective-index.ts` `[Symbol.iterator]`, which builds its own ref
    // object rather than delegating to `get` — so `get` passing says nothing
    // about it.
    const iterated = [...effective].find(([id]) => id === created.expressId);
    expect(iterated).toBeDefined();
    expect(iterated![1].byteOffset).toBe(OVERLAY_BYTE_OFFSET);
    expect(iterated![1].byteLength).toBe(0);

    // And nothing else the iterator yields breaks the pairing either, which is
    // the invariant in the form the incidental readers actually depend on.
    for (const [, ref] of effective) {
      if (ref.byteOffset < 0) expect(ref.byteLength).toBe(0);
    }
  });

  it('an overlay-created ref never enters the index those readers consult', async () => {
    // The second, independent reason. `getPropertySetName` and its siblings
    // read `dataStore.entityIndex.byId` — the PARSED index. The overlay's
    // negative offset lives only in the EFFECTIVE index, which synthesises it
    // on read and never writes it back.
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    const created = new StoreEditor(store, view)
      .addEntity('IFCWALL', [null, null, null, null, null, null, null, null]);

    expect(store.entityIndex.byId.get(created.expressId)).toBeUndefined();
    for (const [, ref] of store.entityIndex.byId) {
      expect(ref.byteOffset).toBeGreaterThanOrEqual(0);
    }
  });
});
