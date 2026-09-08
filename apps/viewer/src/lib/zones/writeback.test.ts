/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildElementWriteBack,
  summarize,
  zonePropertySetName,
  zoneQuantitySetName,
  OUTSIDE_QUANTITY_NAME,
  UNNAMED_ZONE,
  ZONE_PROPERTY_NAMES,
  type ElementZoneFacts,
  type ZoneWriteBackOptions,
} from './writeback.js';

const MESH: ZoneWriteBackOptions = {
  zoneSetName: 'Takt areas',
  zoneSetId: 'set-1',
  basis: 'mesh',
  volumeSiScale: 1,
};

/** A wall of 10 m3 split 4 / 6 across two takt areas, nothing outside. */
function straddler(overrides: Partial<ElementZoneFacts> = {}): ElementZoneFacts {
  return {
    globalId: 42,
    homeZoneName: 'Takt A',
    touchedZoneNames: ['Takt A', 'Takt B'], touchedZoneIds: ['z-takt-a', 'z-takt-b'],
    straddles: true,
    shares: [
      { zoneId: 'z-takt-a', zoneName: 'Takt A', valueM3: 4 },
      { zoneId: 'z-takt-b', zoneName: 'Takt B', valueM3: 6 },
    ],
    outsideM3: 0,
    refusal: null,
    quantityName: null,
    ...overrides,
  };
}

function propValue(
  result: NonNullable<ReturnType<typeof buildElementWriteBack>>,
  name: string,
): string | boolean | undefined {
  return result.properties.find((p) => p.name === name)?.value;
}

describe('zone write-back: what lands on the element', () => {
  it('names both sets after the zone set, and the quantity set after the basis too', () => {
    const result = buildElementWriteBack(straddler(), MESH);
    assert.ok(result);
    assert.equal(result.psetName, 'IfcLite_Zones [Takt areas]');
    assert.equal(result.qsetName, 'IfcLite_ZoneVolumes [Takt areas] (mesh)');
    // The basis is in the NAME, so two bases written for the same set cannot
    // merge into one column downstream.
    assert.notEqual(
      zoneQuantitySetName('Takt areas', 'net'),
      zoneQuantitySetName('Takt areas', 'gross'),
    );
    assert.equal(zonePropertySetName('Takt areas'), 'IfcLite_Zones [Takt areas]');
  });

  it('carries the home zone, every touched zone, and the straddle flag', () => {
    const result = buildElementWriteBack(straddler(), MESH);
    assert.ok(result);
    assert.equal(propValue(result, ZONE_PROPERTY_NAMES.zone), 'Takt A');
    // ", " matches the Lists convention: `equals` excludes straddlers,
    // `contains` includes them (#1869).
    assert.equal(propValue(result, ZONE_PROPERTY_NAMES.zones), 'Takt A, Takt B');
    assert.equal(propValue(result, ZONE_PROPERTY_NAMES.straddles), true);
    assert.equal(propValue(result, ZONE_PROPERTY_NAMES.zoneSet), 'Takt areas');
  });

  it('writes an empty home zone rather than a sentinel when the centroid is in no zone', () => {
    const result = buildElementWriteBack(
      straddler({ homeZoneName: null }),
      MESH,
    );
    assert.ok(result);
    // Not '(none)' / '-' / 'None': any of those is a value a downstream filter
    // cannot tell apart from a zone actually named that.
    assert.equal(propValue(result, ZONE_PROPERTY_NAMES.zone), '');
  });

  it('writes nothing at all for an element in no zone of the set', () => {
    const result = buildElementWriteBack(
      straddler({ touchedZoneNames: [], touchedZoneIds: [], shares: [], homeZoneName: null, straddles: false }),
      MESH,
    );
    assert.equal(result, null);
  });
});

describe('zone write-back: units', () => {
  it('divides by the model\'s own VOLUMEUNIT scale, inverting the read path', () => {
    // A file declaring cubic millimetres: siScale 1e-9. 4 m3 is 4e9 mm3, and
    // writing "4" into it would state four cubic millimetres.
    const result = buildElementWriteBack(straddler(), { ...MESH, volumeSiScale: 1e-9 });
    assert.ok(result);
    // Relative, not exact: 4 / 1e-9 is 3999999999.9999995 in f64. Pinning the
    // exact bits would assert the order of one division rather than the unit
    // conversion, which is what this is about.
    assert.ok(Math.abs(result.quantities[0].value / 4e9 - 1) < 1e-12, `${result.quantities[0].value}`);
    assert.ok(Math.abs(result.quantities[1].value / 6e9 - 1) < 1e-12, `${result.quantities[1].value}`);
  });

  it('falls back to 1 for a missing or nonsensical scale rather than producing NaN', () => {
    for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = buildElementWriteBack(straddler(), { ...MESH, volumeSiScale: scale });
      assert.ok(result, `scale ${scale}`);
      assert.equal(result.quantities[0].value, 4, `scale ${scale}`);
    }
  });
});

describe('zone write-back: the numbers reconcile', () => {
  it('quantities sum to the element whole, including the part in no zone', () => {
    const facts = straddler({
      shares: [
        { zoneId: 'z-takt-a', zoneName: 'Takt A', valueM3: 4 },
        { zoneId: 'z-takt-b', zoneName: 'Takt B', valueM3: 5 },
      ],
      outsideM3: 1,
    });
    const result = buildElementWriteBack(facts, MESH);
    assert.ok(result);
    const total = result.quantities.reduce((a, q) => a + q.value, 0);
    assert.ok(Math.abs(total - 10) < 1e-9, `quantities summed to ${total}`);
    assert.ok(result.quantities.some((q) => q.name === OUTSIDE_QUANTITY_NAME));
  });

  it('omits the outside row when the element is wholly inside the set', () => {
    const result = buildElementWriteBack(straddler(), MESH);
    assert.ok(result);
    assert.ok(!result.quantities.some((q) => q.name === OUTSIDE_QUANTITY_NAME));
  });

  it('drops a zone whose share is clip noise rather than writing a nanolitre row', () => {
    const result = buildElementWriteBack(
      straddler({
        shares: [
          { zoneId: 'z-takt-a', zoneName: 'Takt A', valueM3: 10 },
          { zoneId: 'z-takt-b', zoneName: 'Takt B', valueM3: 1e-17 },
        ],
      }),
      MESH,
    );
    assert.ok(result);
    assert.equal(result.quantities.length, 1);
    assert.equal(result.quantities[0].name, 'Takt A');
  });
});

describe('zone write-back: names that collide', () => {
  it('disambiguates two zones sharing a name instead of losing one', () => {
    // Zone names are free text and not unique-enforced (types.ts: ids
    // disambiguate). Writing "Section 2" twice would silently replace the first
    // quantity with the second, losing a whole zone's volume with no error.
    const result = buildElementWriteBack(
      straddler({
        touchedZoneNames: ['Section 2', 'Section 2'], touchedZoneIds: ['z-section-2', 'z-section-2'],
        shares: [
          { zoneId: 'z-section-2', zoneName: 'Section 2', valueM3: 4 },
          { zoneId: 'z-section-2', zoneName: 'Section 2', valueM3: 6 },
        ],
      }),
      MESH,
    );
    assert.ok(result);
    assert.deepEqual(result.quantities.map((q) => q.name), ['Section 2', 'Section 2 (2)']);
    assert.deepEqual(result.quantities.map((q) => q.value), [4, 6]);
  });

  it('names a blank zone rather than writing an unaddressable empty quantity', () => {
    const result = buildElementWriteBack(
      straddler({
        touchedZoneNames: ['  ', 'Takt B'], touchedZoneIds: ['z---', 'z-takt-b'],
        shares: [
          { zoneId: 'z---', zoneName: '  ', valueM3: 4 },
          { zoneId: 'z-takt-b', zoneName: 'Takt B', valueM3: 6 },
        ],
      }),
      MESH,
    );
    assert.ok(result);
    assert.equal(result.quantities[0].name, UNNAMED_ZONE);
  });
});

describe('zone write-back: the basis travels with the numbers', () => {
  it('records the declared quantity name and the as-built-split disclosure for a net basis', () => {
    const result = buildElementWriteBack(straddler({ quantityName: 'NetVolume' }), {
      zoneSetName: 'Sections',
      zoneSetId: 'set-1',
      basis: 'net',
      volumeSiScale: 1,
    });
    assert.ok(result);
    assert.equal(propValue(result, ZONE_PROPERTY_NAMES.volumeBasis), 'net');
    assert.equal(propValue(result, ZONE_PROPERTY_NAMES.volumeQuantity), 'NetVolume');
    // The ratio was measured on the as-built mesh; applying it to a declared
    // total is an approximation, and the file has to say so (#2199's rule).
    assert.match(String(propValue(result, ZONE_PROPERTY_NAMES.volumeNote)), /as-built mesh/);
  });

  it('states no such disclosure for the mesh basis, which was measured directly', () => {
    const result = buildElementWriteBack(straddler(), MESH);
    assert.ok(result);
    assert.equal(propValue(result, ZONE_PROPERTY_NAMES.volumeNote), undefined);
    assert.equal(propValue(result, ZONE_PROPERTY_NAMES.volumeQuantity), undefined);
  });
});

describe('zone write-back: refusals', () => {
  it('writes the zone names and a stated reason, and no quantity set at all', () => {
    const result = buildElementWriteBack(
      straddler({ shares: [], refusal: 'unproved-solid' }),
      MESH,
    );
    assert.ok(result);
    assert.equal(result.qsetName, null);
    assert.equal(result.quantities.length, 0);
    // Still classified - the classification is geometric-AABB and did not need
    // a proven solid.
    assert.equal(propValue(result, ZONE_PROPERTY_NAMES.zones), 'Takt A, Takt B');
    assert.match(String(propValue(result, ZONE_PROPERTY_NAMES.volumeUnavailable)), /proven closed solid/);
    // A basis label on an element with no numbers would claim a measurement
    // that was refused.
    assert.equal(propValue(result, ZONE_PROPERTY_NAMES.volumeBasis), undefined);
  });

  it('refuses rather than silently falling back to the mesh when the basis is not declared', () => {
    // Falling back would put a mesh number inside a quantity set NAMED net,
    // which is precisely the mixed-basis confusion volume-basis.ts exists to
    // prevent.
    const result = buildElementWriteBack(
      straddler({ shares: [], refusal: 'no-declared-quantity' }),
      { zoneSetName: 'Sections', zoneSetId: 'set-1', basis: 'net', volumeSiScale: 1 },
    );
    assert.ok(result);
    assert.equal(result.qsetName, null);
    assert.match(String(propValue(result, ZONE_PROPERTY_NAMES.volumeUnavailable)), /declares no volume quantity/);
  });

  it('distinguishes the federation-rescaled refusal, whose fix is elsewhere', () => {
    const result = buildElementWriteBack(
      straddler({ shares: [], refusal: 'rescaled-by-alignment' }),
      MESH,
    );
    assert.ok(result);
    assert.match(String(propValue(result, ZONE_PROPERTY_NAMES.volumeUnavailable)), /Federation alignment/);
  });

  it('writes the pset without a quantity set when every share was negligible', () => {
    const result = buildElementWriteBack(
      straddler({ shares: [{ zoneId: 'z-takt-a', zoneName: 'Takt A', valueM3: 0 }], outsideM3: 0 }),
      MESH,
    );
    assert.ok(result);
    assert.equal(result.qsetName, null);
    assert.equal(propValue(result, ZONE_PROPERTY_NAMES.volumeBasis), undefined);
  });
});

describe('zone write-back: run summary', () => {
  it('counts written, volume-bearing, refused and skipped separately', () => {
    const results = [
      buildElementWriteBack(straddler(), MESH),
      buildElementWriteBack(straddler({ shares: [], refusal: 'no-geometry' }), MESH),
      buildElementWriteBack(straddler({ touchedZoneNames: [], touchedZoneIds: [] }), MESH),
    ];
    assert.deepEqual(summarize(results), {
      written: 2,
      withVolumes: 1,
      refused: 1,
      skippedNoZone: 1,
    });
  });
});
