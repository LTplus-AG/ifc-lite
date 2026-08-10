/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The type-inheritance half of "which volumes may a zone breakdown be taken
 * on" (#2508 / #1745 / #1755).
 *
 * Two failure modes are pinned, and they pull in opposite directions:
 *
 *  - dropping the type's sets entirely, which shows a mesh basis alone for
 *    every catalogue-driven element whose `NetVolume` lives on its type;
 *  - letting the type's sets WIN, which silently replaces an occurrence's own
 *    declared volume with the catalogue's nominal one.
 *
 * Order is what separates those, so order is what the tests assert.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  withInheritedTypeQuantities,
  type InheritableQuantitySet,
  type TypeQuantityStoreLike,
} from './inherited-quantities.js';
import { declaredVolumeBases } from './volume-basis.js';

const DEFINES_BY_TYPE = 7;

const qset = (name: string, qName: string, value: number): InheritableQuantitySet => ({
  name,
  quantities: [{ name: qName, type: 2, value }],
});

/** A store that resolves `expressId -> typeId 700` and answers the table for
 *  the TYPE's id only. Answering for the occurrence's id too would let a fix
 *  that reads the wrong id pass. */
function storeOf(over: Partial<TypeQuantityStoreLike> & { typeSets?: InheritableQuantitySet[] } = {}): TypeQuantityStoreLike {
  const typeSets = over.typeSets ?? [qset('Qto_DoorBaseQuantities', 'NetVolume', 0.4)];
  return {
    source: over.source ?? null,
    relationships: 'relationships' in over ? over.relationships : { getRelated: () => [700] },
    quantities: over.quantities ?? { getForEntity: (id: number) => (id === 700 ? typeSets : []) },
  };
}

/** Stands in for `extractTypeQuantitiesOnDemand`; only the SOURCE-backed path
 *  may call it, so a call with an empty source is itself a failure. */
const sourceExtractor = (sets: InheritableQuantitySet[]) =>
  (store: TypeQuantityStoreLike): InheritableQuantitySet[] => {
    assert.ok(store.source?.length, 'the source extractor must not run on a server-parsed store');
    return sets;
  };

describe('quantity sets a zone volume breakdown may read (#2508)', () => {
  it('appends the type\'s sets on the server-parsed path, where source is empty', () => {
    // `extractTypeQuantitiesOnDemand` returns null outright when there is no
    // STEP source, which is every server-parsed store — so the prebuilt table
    // keyed by the TYPE's id is the only place these can come from.
    const out = withInheritedTypeQuantities([], storeOf(), 42, DEFINES_BY_TYPE, () => null);
    assert.equal(out.length, 1);
    assert.equal(out[0].quantities[0].name, 'NetVolume');
  });

  it('appends the type\'s sets on the source-backed path', () => {
    const store = storeOf({ source: { length: 128 } });
    const out = withInheritedTypeQuantities(
      [],
      store,
      42,
      DEFINES_BY_TYPE,
      sourceExtractor([qset('Qto_DoorBaseQuantities', 'GrossVolume', 0.6)]),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].quantities[0].name, 'GrossVolume');
  });

  it('keeps the occurrence FIRST, so its own basis still wins', () => {
    const own = [qset('Qto_DoorBaseQuantities', 'NetVolume', 0.9)];
    const out = withInheritedTypeQuantities(own, storeOf(), 42, DEFINES_BY_TYPE, () => null);
    // Both declare a net volume; `declaredVolumeBases` keeps the first per
    // basis, so the OCCURRENCE's 0.9 must be the one that survives — not the
    // type's nominal 0.4.
    const bases = declaredVolumeBases(out, 1);
    assert.equal(bases.length, 1);
    assert.equal(bases[0].basis, 'net');
    assert.equal(bases[0].valueM3, 0.9);
  });

  it('fills a basis the occurrence is silent on', () => {
    const own = [qset('Qto_DoorBaseQuantities', 'GrossVolume', 1.2)];
    const bases = declaredVolumeBases(
      withInheritedTypeQuantities(own, storeOf(), 42, DEFINES_BY_TYPE, () => null),
      1,
    );
    assert.deepEqual(
      bases.map((b) => [b.basis, b.valueM3]).sort(),
      [['gross', 1.2], ['net', 0.4]].sort(),
    );
  });

  it('returns the SAME array when there is nothing to inherit', () => {
    const own = [qset('Qto_DoorBaseQuantities', 'NetVolume', 0.9)];
    // Identity, not just equality: a new array every render would re-run every
    // downstream memo that depends on it.
    assert.equal(withInheritedTypeQuantities(own, storeOf({ typeSets: [] }), 42, DEFINES_BY_TYPE, () => null), own);
    assert.equal(withInheritedTypeQuantities(own, storeOf({ relationships: { getRelated: () => [] } }), 42, DEFINES_BY_TYPE, () => null), own);
    assert.equal(withInheritedTypeQuantities(own, null, 42, DEFINES_BY_TYPE, () => null), own);
    assert.equal(withInheritedTypeQuantities(own, storeOf(), undefined, DEFINES_BY_TYPE, () => null), own);
  });
});
