/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  allBasisBreakdowns,
  basisBreakdown,
  declaredVolumeBases,
  volumeBasisFromQuantityName,
  volumeBasisRatioNote,
  VOLUME_QUANTITY_TYPE,
} from './volume-basis.js';

const AREA = 1;
const VOLUME = VOLUME_QUANTITY_TYPE;

/** A 6 m wall split 40 / 60 by one boundary, with 0% left outside. */
const SPLIT = {
  wholeVolumeM3: 7.2,
  shares: [
    { zoneId: 'a', zoneName: 'Section 1', fraction: 0.4 },
    { zoneId: 'b', zoneName: 'Section 2', fraction: 0.6 },
  ],
  outsideFraction: 0,
};

describe('zones/volume-basis', () => {
  describe('classifying a declared quantity', () => {
    it('reads the opening convention off the name prefix', () => {
      assert.strictEqual(volumeBasisFromQuantityName('NetVolume'), 'net');
      assert.strictEqual(volumeBasisFromQuantityName('NetSideVolume'), 'net');
      assert.strictEqual(volumeBasisFromQuantityName('GrossVolume'), 'gross');
      assert.strictEqual(volumeBasisFromQuantityName('GrossFootprintVolume'), 'gross');
    });

    it('a bare Volume is UNQUALIFIED, not net', () => {
      // The load-bearing case. Measured on 01_BIMcollab_Example_ARC.ifc the
      // declared `net` matches the as-built mesh for 300/300 elements within
      // 1%, while `unqualified` disagrees by a median 11.7% — so treating one
      // as the other is not a harmless simplification.
      assert.strictEqual(volumeBasisFromQuantityName('Volume'), 'unqualified');
      assert.strictEqual(volumeBasisFromQuantityName('TotalVolume'), 'unqualified');
      assert.strictEqual(volumeBasisFromQuantityName(''), 'unqualified');
    });

    it('is case- and whitespace-insensitive', () => {
      assert.strictEqual(volumeBasisFromQuantityName('  netvolume '), 'net');
      assert.strictEqual(volumeBasisFromQuantityName('GROSSVOLUME'), 'gross');
    });
  });

  describe('collecting declared volumes', () => {
    it('takes volumes only, by QuantityType and never by name', () => {
      // `NetSideArea` starts with "Net" and is not a volume; `Q_Body` is a
      // volume with a name no list would predict.
      const sets = [{
        name: 'Qto_WallBaseQuantities',
        quantities: [
          { name: 'NetSideArea', type: AREA, value: 21.15 },
          { name: 'Q_Body', type: VOLUME, value: 4.23 },
        ],
      }];
      const got = declaredVolumeBases(sets, 1);
      assert.deepStrictEqual(got, [{ basis: 'unqualified', quantityName: 'Q_Body', valueM3: 4.23 }]);
    });

    it('normalises through the file VOLUMEUNIT scale, not a hand-rolled factor', () => {
      // A millimetre-volume file: 4.23e9 mm3 is 4.23 m3.
      const sets = [{ name: 'Q', quantities: [{ name: 'NetVolume', type: VOLUME, value: 4.23e9 }] }];
      const [d] = declaredVolumeBases(sets, 1e-9);
      assert.ok(d);
      assert.ok(Math.abs(d.valueM3 - 4.23) < 1e-9, `expected 4.23 m3, got ${d.valueM3}`);
    });

    it('keeps the three bases apart and never sums them', () => {
      const sets = [{
        name: 'Q',
        quantities: [
          { name: 'NetVolume', type: VOLUME, value: 4 },
          { name: 'GrossVolume', type: VOLUME, value: 5 },
          { name: 'Volume', type: VOLUME, value: 6 },
        ],
      }];
      const got = declaredVolumeBases(sets, 1);
      assert.deepStrictEqual(got.map((d) => [d.basis, d.valueM3]), [['net', 4], ['gross', 5], ['unqualified', 6]]);
    });

    it('a basis declared twice keeps the first, rather than double counting', () => {
      const sets = [
        { name: 'A', quantities: [{ name: 'NetVolume', type: VOLUME, value: 4 }] },
        { name: 'B', quantities: [{ name: 'NetVolume', type: VOLUME, value: 9 }] },
      ];
      const got = declaredVolumeBases(sets, 1);
      assert.strictEqual(got.length, 1);
      assert.strictEqual(got[0]!.valueM3, 4);
    });

    it('drops non-finite values instead of publishing NaN m3', () => {
      const sets = [{ name: 'Q', quantities: [{ name: 'NetVolume', type: VOLUME, value: Number.NaN }] }];
      assert.deepStrictEqual(declaredVolumeBases(sets, 1), []);
    });

    it('a non-positive or non-finite unit scale falls back to SI rather than zeroing every volume', () => {
      const sets = [{ name: 'Q', quantities: [{ name: 'NetVolume', type: VOLUME, value: 4.23 }] }];
      assert.strictEqual(declaredVolumeBases(sets, 0)[0]!.valueM3, 4.23);
      assert.strictEqual(declaredVolumeBases(sets, Number.NaN)[0]!.valueM3, 4.23);
    });
  });

  describe('re-expressing a split on a named basis', () => {
    it('mesh is the identity on the clipped numbers', () => {
      const b = basisBreakdown(SPLIT, 'mesh', SPLIT.wholeVolumeM3, null);
      assert.ok(Math.abs(b.shares[0]!.valueM3 - 2.88) < 1e-12, `got ${b.shares[0]!.valueM3}`);
      assert.ok(Math.abs(b.shares[1]!.valueM3 - 4.32) < 1e-12, `got ${b.shares[1]!.valueM3}`);
      assert.strictEqual(b.outsideM3, 0);
    });

    it('a declared basis RECONCILES with the declared total by construction', () => {
      // The whole point of question 2: a user who trusts NetVolume = 4.5 m3
      // must see per-zone numbers that add back up to 4.5, not to the mesh.
      const b = basisBreakdown(SPLIT, 'net', 4.5, 'NetVolume');
      const summed = b.shares.reduce((a, s) => a + s.valueM3, 0) + b.outsideM3;
      assert.ok(Math.abs(summed - 4.5) < 1e-12, `net shares must sum to the declared 4.5, got ${summed}`);
      assert.ok(Math.abs(b.shares[0]!.valueM3 - 1.8) < 1e-12);
      assert.strictEqual(b.quantityName, 'NetVolume');
    });

    it('the uncovered remainder scales with the basis too', () => {
      const partial = { wholeVolumeM3: 7.2, shares: [{ zoneId: 'a', zoneName: 'S1', fraction: 0.25 }], outsideFraction: 0.75 };
      const b = basisBreakdown(partial, 'gross', 8, 'GrossVolume');
      assert.strictEqual(b.shares[0]!.valueM3, 2);
      assert.strictEqual(b.outsideM3, 6);
    });

    it('offers mesh first, then every declared basis, each carrying its name', () => {
      const declared = declaredVolumeBases(
        [{ name: 'Q', quantities: [
          { name: 'GrossVolume', type: VOLUME, value: 5 },
          { name: 'NetVolume', type: VOLUME, value: 4 },
        ] }],
        1,
      );
      const all = allBasisBreakdowns(SPLIT, declared);
      assert.deepStrictEqual(all.map((b) => b.basis), ['mesh', 'net', 'gross']);
      assert.deepStrictEqual(all.map((b) => b.totalM3), [7.2, 4, 5]);
      assert.deepStrictEqual(all.map((b) => b.quantityName), [null, 'NetVolume', 'GrossVolume']);
    });

    it('an element with no declared volume still gets the mesh basis', () => {
      const all = allBasisBreakdowns(SPLIT, []);
      assert.strictEqual(all.length, 1);
      assert.strictEqual(all[0]!.basis, 'mesh');
    });
  });

  describe('the disclosure that travels with a declared basis', () => {
    it('mesh needs none — its split IS its geometry', () => {
      assert.strictEqual(volumeBasisRatioNote('mesh'), null);
    });

    it('every other basis says the ratio came from the as-built mesh', () => {
      for (const basis of ['net', 'gross', 'unqualified'] as const) {
        const note = volumeBasisRatioNote(basis);
        assert.ok(note && note.includes('as-built mesh'), `${basis} must disclose where its ratio came from`);
      }
    });
  });
});
