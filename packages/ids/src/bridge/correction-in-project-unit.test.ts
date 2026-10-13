/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The unit of an IDS correction (#7542).
 *
 * The viewer converts a correction with `propertyValueToRaw`, then writes it
 * through `MutablePropertyView.setProperty` with no unit. The view edits an
 * `IfcPropertySingleValue` that the entity's own property sets hold in place,
 * and keeps its `Unit`. Any other entry has no base entry in the view, so the
 * correction becomes a new property with no unit. `StepExporter` writes that
 * in a new `IfcPropertySet`. These entries are every quantity, and every entry
 * the entity inherits from its type. Their own `Unit` does not apply to the
 * write, so the correction is converted to the project unit, and the overlay
 * reads it back in that unit. Converted to the entry's own unit instead, the
 * session passed and the exported file was 1000 times off.
 * docs/architecture/evidence/7542-type-quantity-sets has the exported lines.
 *
 * A property the entity holds in its own property set keeps its own `Unit`.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { checkPropertyFacet } from '../index.js';
import type { IDSPropertyFacet, IFCDataAccessor } from '../types.js';
import { createDataAccessor, propertyValueToRaw, type PropertyOverride } from './index.js';

const W1 = 20; // typed, no sets of its own
const W2 = 21; // typed, its own Pset_Own.Span in millimetres
const W3 = 22; // not typed, its own Qto_WallBaseQuantities.Height in millimetres
const WT = 50;
const QTO = 'Qto_WallBaseQuantities';
const PSET = 'Pset_TypeOwnUnit';
const LENGTH = 'IFCLENGTHMEASURE';
const MM_PROJECT = '.MILLI.,.METRE.';

const gid = (prefix: string, id: number) => prefix + String(id).padStart(22 - prefix.length, '0');
const real = (value: number) => (Number.isInteger(value) ? `${value}.` : String(value));

interface Fixture {
  /** A correction as `StepExporter` writes it. */
  written?: string;
  /** The type's `HasPropertySets`. */
  typeSets?: string;
  /** The project's length unit, `IFCSIUNIT(*,.LENGTHUNIT.,<this>)`. */
  lengthUnit?: string;
  /** The `Unit` of the type's Length quantity. */
  typeLengthUnit?: string;
}

/** By default a metre project. The type holds Length 5000 and Width 200, each
 *  with its own millimetre `Unit`. */
function model({ written = '', typeSets = '#51,#53', lengthUnit = '$,.METRE.', typeLengthUnit = '#4' }: Fixture = {}): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('type-unit.ifc','2026-10-13T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${gid('0proj', 1)}',$,'P',$,$,$,$,$,#3);
#2=IFCSIUNIT(*,.LENGTHUNIT.,${lengthUnit});
#3=IFCUNITASSIGNMENT((#2));
#4=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#${W1}=IFCWALL('${gid('0wall', W1)}',$,'W1',$,$,$,$,$,$);
#${W2}=IFCWALL('${gid('0wall', W2)}',$,'W2',$,$,$,$,$,$);
#${W3}=IFCWALL('${gid('0wall', W3)}',$,'W3',$,$,$,$,$,$);
#30=IFCPROPERTYSET('${gid('0pset', 30)}',$,'Pset_Own',$,(#31));
#31=IFCPROPERTYSINGLEVALUE('Span',$,IFCLENGTHMEASURE(5000.),#4);
#32=IFCRELDEFINESBYPROPERTIES('${gid('0rdbp', 32)}',$,$,$,(#${W2}),#30);
#40=IFCELEMENTQUANTITY('${gid('0qto', 40)}',$,'${QTO}',$,$,(#41));
#41=IFCQUANTITYLENGTH('Height',$,#4,3000.,$);
#42=IFCRELDEFINESBYPROPERTIES('${gid('0rdbp', 42)}',$,$,$,(#${W3}),#40);
#${WT}=IFCWALLTYPE('${gid('0type', WT)}',$,'WT',$,$,(${typeSets}),$,$,$,.STANDARD.);
#51=IFCELEMENTQUANTITY('${gid('0qto', 51)}',$,'${QTO}',$,$,(#52));
#52=IFCQUANTITYLENGTH('Length',$,${typeLengthUnit},5000.,$);
#53=IFCPROPERTYSET('${gid('0pset', 53)}',$,'${PSET}',$,(#54));
#54=IFCPROPERTYSINGLEVALUE('Width',$,IFCLENGTHMEASURE(200.),#4);
#55=IFCRELDEFINESBYTYPE('${gid('0rdbt', 55)}',$,$,$,(#${W1},#${W2}),#${WT});
${written}
ENDSEC;
END-ISO-10303-21;`;
}

/** A correction as `StepExporter` writes it: a new property set holding the
 *  value with no `Unit`, attached to the occurrence or listed on the type. */
function exported(id: number, pset: string, prop: string, raw: number): string {
  const value = `#80=IFCPROPERTYSINGLEVALUE('${prop}',$,IFCLENGTHMEASURE(${real(raw)}),$);
#81=IFCPROPERTYSET('${gid('0corr', 81)}',$,'${pset}',$,(#80));`;
  return id === WT
    ? model({ written: value, typeSets: '#51,#53,#81' })
    : model({ written: `${value}\n#82=IFCRELDEFINESBYPROPERTIES('${gid('0corr', 82)}',$,$,$,(#${id}),#81);` });
}

async function parse(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer);
}

const overlayOn = (id: number, overrides: PropertyOverride[]) => (e: number) => (e === id ? overrides : undefined);
const valueOf = (a: IFCDataAccessor, id: number, pset: string, prop: string) => a.getPropertyValue(id, pset, prop)?.value;
const facet = (pset: string, prop: string, value?: string): IDSPropertyFacet => ({
  type: 'property',
  propertySet: { type: 'simpleValue', value: pset },
  baseName: { type: 'simpleValue', value: prop },
  dataType: { type: 'simpleValue', value: LENGTH },
  ...(value === undefined ? {} : { value: { type: 'simpleValue' as const, value } }),
});

describe('a correction written with no unit is converted in the project unit (#7542)', () => {
  for (const [label, id, pset, prop, before, target] of [
    ['an inherited quantity', W1, QTO, 'Length', 5, 6],
    ['an inherited property', W1, PSET, 'Width', 0.2, 0.3],
    ['a quantity of the type object checked directly', WT, QTO, 'Length', 5, 6],
  ] as const) {
    it(`${label} with its own Unit: the raw value, the session and the exported file agree`, async () => {
      const store = await parse(model());
      expect(valueOf(createDataAccessor(store), id, pset, prop)).toBeCloseTo(before, 9);

      const raw = propertyValueToRaw(store, id, pset, prop, LENGTH, target);
      expect(raw).toBeCloseTo(target, 9);

      const inSession = createDataAccessor(store, overlayOn(id, [{ psetName: pset, propName: prop, value: raw, dataType: LENGTH }]));
      expect(valueOf(inSession, id, pset, prop)).toBeCloseTo(target, 9);
      expect(checkPropertyFacet(facet(pset, prop, String(target)), id, inSession).passed).toBe(true);

      const reparsed = createDataAccessor(await parse(exported(id, pset, prop, raw as number)));
      expect(valueOf(reparsed, id, pset, prop)).toBeCloseTo(target, 9);
      expect(checkPropertyFacet(facet(pset, prop, String(target)), id, reparsed).passed).toBe(true);
    });

    it(`${label} with its own Unit: the overlay reads an override in the project unit, also a second one`, async () => {
      const store = await parse(model());
      const once = createDataAccessor(store, overlayOn(id, [{ psetName: pset, propName: prop, value: target }]));
      expect(valueOf(once, id, pset, prop)).toBeCloseTo(target, 9);
      // The replaced entry now holds a value written with no unit, so a
      // second override of it reads in the project unit too.
      const twice = createDataAccessor(store, overlayOn(id, [
        { psetName: pset, propName: prop, value: before },
        { psetName: pset, propName: prop, value: target },
      ]));
      expect(valueOf(twice, id, pset, prop)).toBeCloseTo(target, 9);
    });
  }

  it("an occurrence's own quantity with its own Unit: the raw value, the session and the exported value are in the project unit", async () => {
    const store = await parse(model());
    expect(valueOf(createDataAccessor(store), W3, QTO, 'Height')).toBeCloseTo(3, 9);

    const raw = propertyValueToRaw(store, W3, QTO, 'Height', LENGTH, 4);
    expect(raw).toBeCloseTo(4, 9);
    const inSession = createDataAccessor(store, overlayOn(W3, [{ psetName: QTO, propName: 'Height', value: raw, dataType: LENGTH }]));
    expect(valueOf(inSession, W3, QTO, 'Height')).toBeCloseTo(4, 9);
    expect(checkPropertyFacet(facet(QTO, 'Height', '4'), W3, inSession).passed).toBe(true);

    // The viewer writes the correction into a new property set beside the
    // quantity set, so the file holds two sets of that name: 4 m and 3 m.
    // IDS then fails the requirement on the file, on every build (scenario D
    // in the evidence README). But the written value is 4 m, not 4 km.
    const reparsed = createDataAccessor(await parse(exported(W3, QTO, 'Height', raw as number)));
    const heights = reparsed.getPropertySets(W3)
      .filter((s) => s.name === QTO)
      .map((s) => Number(s.properties.find((p) => p.name === 'Height')?.value));
    expect(heights.sort((x, y) => x - y)).toEqual([3, 4]);
  });

  it("an occurrence's own quantity with its own Unit: the overlay reads an override in the project unit", async () => {
    const store = await parse(model());
    const a = createDataAccessor(store, overlayOn(W3, [{ psetName: QTO, propName: 'Height', value: 4 }]));
    expect(valueOf(a, W3, QTO, 'Height')).toBeCloseTo(4, 9);
  });

  it('control: a property the occurrence holds in its own property set keeps its own Unit', async () => {
    const store = await parse(model());
    // W2's own Span, 5000 mm. The viewer edits it in place and keeps its Unit.
    expect(propertyValueToRaw(store, W2, 'Pset_Own', 'Span', LENGTH, 6)).toBeCloseTo(6000, 9);
    const w2 = createDataAccessor(store, overlayOn(W2, [{ psetName: 'Pset_Own', propName: 'Span', value: 6000 }]));
    expect(valueOf(w2, W2, 'Pset_Own', 'Span')).toBeCloseTo(6, 9);
  });

  it('control: a property the type object holds in its own property set keeps its own Unit', async () => {
    const store = await parse(model());
    expect(propertyValueToRaw(store, WT, PSET, 'Width', LENGTH, 0.3)).toBeCloseTo(300, 9);
    const wt = createDataAccessor(store, overlayOn(WT, [{ psetName: PSET, propName: 'Width', value: 300 }]));
    expect(valueOf(wt, WT, PSET, 'Width')).toBeCloseTo(0.3, 9);
  });
});

describe('a correction to an inherited quantity finds that quantity (#7542)', () => {
  // A millimetre project; the type's Length has no Unit of its own.
  const mmProject = () => parse(model({ lengthUnit: MM_PROJECT, typeLengthUnit: '$' }));

  it("propertyValueToRaw with no dataType converts by the quantity's measure type", async () => {
    expect(propertyValueToRaw(await mmProject(), W1, QTO, 'Length', undefined, 5)).toBeCloseTo(5000, 9);
  });

  it("an override with no dataType is read by the quantity's measure type", async () => {
    const a = createDataAccessor(await mmProject(), overlayOn(W1, [{ psetName: QTO, propName: 'Length', value: 7000 }]));
    expect(valueOf(a, W1, QTO, 'Length')).toBeCloseTo(7, 9);
  });

  it('an override that deletes it leaves the set with no items', async () => {
    const a = createDataAccessor(await parse(model()), overlayOn(W1, [{ psetName: QTO, propName: 'Length', value: null, deleted: true }]));
    expect(a.getPropertySets(W1).filter((s) => s.name === QTO).map((s) => s.properties.length)).toEqual([0]);
    const result = checkPropertyFacet(facet(QTO, 'Length'), W1, a);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PROPERTY_MISSING');
  });
});
