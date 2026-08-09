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
import { IfcParser, CompactEntityIndexBuilder, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';
import { createSourceRefReader } from './source-ref-bounds.js';

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
  (copy as { source: Uint8Array }).source = new Uint8Array(0);
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
