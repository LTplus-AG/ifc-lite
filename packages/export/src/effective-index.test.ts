/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The index invariants every export pass is entitled to assume (#2012).
 *
 * `EffectiveEntityIndex` is a Map-like view, and the passes that consume it mix
 * `has`, `get`, iteration and `size` freely: `collectReferencedEntityIds` seeds
 * roots with `has` and then reads them with `get`, `getVisibleEntityIds`
 * iterates, and the closure walk filters on `has`. If those four disagree about
 * one id, the disagreement surfaces later as a dangling reference in some
 * export mode nobody thought to test — which is exactly how this class of bug
 * stayed alive. So the agreement is asserted directly rather than only through
 * a file that happens to expose it.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { getEffectiveEntityIndex, authoredEntityRefs } from './effective-index.js';

function guid(tag: string): string {
  return (tag + '0'.repeat(22)).slice(0, 22);
}

const BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('base.ifc','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${guid('proj')}',$,'P',$,$,$,$,$,$);
#2=IFCWALL('${guid('wallA')}',$,'A',$,$,$,$,$,$);
#3=IFCWALL('${guid('wallB')}',$,'B',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

async function parseBase(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(BASE_IFC);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}

function newView(store: IfcDataStore): { view: MutablePropertyView; editor: StoreEditor } {
  const view = new MutablePropertyView(null, 'test-model');
  return { view, editor: new StoreEditor(store, view) };
}

describe('EffectiveEntityIndex agrees with itself', () => {
  it('answers has / get / iteration / size the same way about every id', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    const created = editor.addEntity('IfcWall', [guid('newC'), null, 'C', null, null, null, null, null, null]);
    // Created and then deleted in the same session: tombstoned (so `isDeleted`
    // can answer) but never a store entity, so it must not be counted as one.
    const undone = editor.addEntity('IfcWall', [guid('newD'), null, 'D', null, null, null, null, null, null]);
    editor.removeEntity(undone.expressId);
    editor.removeEntity(3);

    const index = getEffectiveEntityIndex(store, view, true);
    const iterated = new Map([...index]);

    expect(index.has(undone.expressId)).toBe(false);
    expect(index.get(undone.expressId)).toBeUndefined();
    expect(iterated.has(undone.expressId)).toBe(false);
    expect(index.isDeleted(undone.expressId)).toBe(true);

    // Deleted: absent from all four.
    expect(index.has(3)).toBe(false);
    expect(index.get(3)).toBeUndefined();
    expect(iterated.has(3)).toBe(false);
    expect(index.isDeleted(3)).toBe(true);

    // Created: present in all four.
    expect(index.has(created.expressId)).toBe(true);
    expect(index.get(created.expressId)?.type).toBe('IfcWall');
    expect(iterated.has(created.expressId)).toBe(true);
    expect(index.isOverlayCreated(created.expressId)).toBe(true);

    // Untouched source entity: present, and not claimed by the overlay.
    expect(index.has(2)).toBe(true);
    expect(iterated.has(2)).toBe(true);
    expect(index.isOverlayCreated(2)).toBe(false);
    expect(index.isDeleted(2)).toBe(false);

    // `size` is the count iteration yields: one source entity removed, one
    // overlay entity added.
    expect(index.size).toBe(iterated.size);
    expect(index.size).toBe(store.entityIndex.byId.size);
  });

  it('moves a retyped entity between byType buckets without touching the store', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    editor.setEntityType(2, 'IfcColumn');
    const created = editor.addEntity('IfcBeam', [guid('newB'), null, 'Beam', null, null, null, null, null, null]);
    editor.removeEntity(3);

    const index = getEffectiveEntityIndex(store, view, true);

    expect(index.byType.get('IFCWALL') ?? []).toEqual([]);
    expect(index.byType.get('IFCCOLUMN')).toEqual([2]);
    expect(index.byType.get('IFCBEAM')).toEqual([created.expressId]);
    expect(index.typeOf(2)).toBe('IFCCOLUMN');
    // The store's own index is untouched: it is shared, immutable, and every
    // other reader still sees the file as parsed.
    expect(store.entityIndex.byType.get('IFCWALL')).toEqual([2, 3]);
  });

  it('reads outgoing references off an authored payload, never off bytes it has none of', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    const point = editor.addEntity('IfcCartesianPoint', [[{ real: 0 }, { real: 0 }, { real: 0 }]]);
    const placement = editor.addEntity('IfcAxis2Placement3D', [`#${point.expressId}`, null, null]);

    const index = getEffectiveEntityIndex(store, view, true);

    expect(index.refsOf(placement.expressId)).toEqual([point.expressId]);
    // A source record has bytes; the caller must scan those, not ask here.
    expect(index.refsOf(2)).toBeUndefined();
  });

  it('takes the source-only path when nothing structural is queued', async () => {
    const store = await parseBase();
    const { view } = newView(store);
    view.setAttribute(2, 'Name', 'Renamed');

    const index = getEffectiveEntityIndex(store, view, true);

    // An attribute edit changes no entity's existence or class, so the view is
    // the store's own — the wrapper is not paid for.
    expect(index.byType).toBe(store.entityIndex.byType);
    expect(index.size).toBe(store.entityIndex.byId.size);
    expect(index.isDeleted(2)).toBe(false);
  });

  it('ignores the overlay entirely when mutations are not being applied', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    editor.addEntity('IfcWall', [guid('unseen'), null, 'Unseen', null, null, null, null, null, null]);
    editor.removeEntity(3);

    const index = getEffectiveEntityIndex(store, view, false);

    expect(index.size).toBe(store.entityIndex.byId.size);
    expect(index.has(3)).toBe(true);
    expect(index.isDeleted(3)).toBe(false);
  });
});

describe('authoredEntityRefs tells a reference from text', () => {
  it('accepts the documented `#42` form, recursing into lists', () => {
    expect(authoredEntityRefs('#42')).toEqual([42]);
    expect(authoredEntityRefs([' #7 ', '#8'])).toEqual([7, 8]);
  });

  it('rejects everything that merely looks like one', () => {
    // A Name that mentions an id is text — the same distinction the byte
    // scanner makes inside a STEP string literal.
    expect(authoredEntityRefs('detail #999')).toEqual([]);
    expect(authoredEntityRefs('#')).toEqual([]);
    expect(authoredEntityRefs('#0')).toEqual([]);
    expect(authoredEntityRefs('#12abc')).toEqual([]);
    expect(authoredEntityRefs('$')).toEqual([]);
    // A bare number is a measure, not an id: reading it as one would pull
    // arbitrary entities into an export closure.
    expect(authoredEntityRefs(42)).toEqual([]);
  });
});
