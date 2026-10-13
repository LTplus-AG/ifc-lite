/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7547 through a parsed model. A self-referencing `IfcDerivedUnit` (#50 ->
 * #51 -> #50) was named as a property's and a quantity's own `Unit`, or listed
 * in the project's `IfcUnitAssignment`. It made the public readers throw
 * `RangeError: Maximum call stack size exceeded` (and with them the IDS bridge
 * and rules, which read through them). Each reader now reports the unit the
 * way it reports any unit it cannot resolve, and every sound unit beside it
 * reads as before. A flat derived unit of any width, which the read budget
 * never charges, reads as it did before the bound, and each reader resolves a
 * named unit it names once. A wide unit over an entity the schema does not
 * allow there is charged, and so is an element listed twice. A flat unit whose
 * symbol passes the engine's string limit is unresolved. Read through a native
 * view, a chain of nested units resolves as before; the depth cap is for the
 * parsed source. `src/project-unit-walk.test.ts` covers the other shapes.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  EntityExtractor, IfcParser, extractProjectUnits, extractPropertiesOnDemand, extractQuantitiesOnDemand, extractTypeEntityOwnQuantities,
} from '../src/index.js';
import type { MetadataReadView } from '../src/effective-metadata-record.js';

const gid = (n: number) => String(n).padStart(22, '0');
const LOOP = ["#50=IFCDERIVEDUNIT((#51),.USERDEFINED.,'loop');", '#51=IFCDERIVEDUNITELEMENT(#50,1);'];

/** Wall #10 with `Looped` (own Unit `unit`), `Milli` (own Unit mm) and `Plain`, and quantity `Len` (own Unit `unit`). */
function model(assignment: string, unit: string): ArrayBuffer {
  const text = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    "FILE_NAME('unit-walk.ifc','2026-10-13T00:00:00',(''),(''),'','','');", "FILE_SCHEMA(('IFC4X3_ADD2'));", 'ENDSEC;', 'DATA;',
    `#1=IFCPROJECT('${gid(1)}',$,'P',$,$,$,$,$,#3);`,
    '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
    `#3=IFCUNITASSIGNMENT((${assignment}));`,
    '#4=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
    `#10=IFCWALL('${gid(10)}',$,'W',$,$,$,$,$,$);`,
    ...LOOP,
    `#35=IFCPROPERTYSINGLEVALUE('Looped',$,IFCLENGTHMEASURE(2.5),${unit});`,
    "#36=IFCPROPERTYSINGLEVALUE('Milli',$,IFCLENGTHMEASURE(2500.),#4);",
    "#37=IFCPROPERTYSINGLEVALUE('Plain',$,IFCLENGTHMEASURE(2.5),$);",
    `#40=IFCPROPERTYSET('${gid(40)}',$,'Probe_Set',$,(#35,#36,#37));`,
    `#41=IFCRELDEFINESBYPROPERTIES('${gid(41)}',$,$,$,(#10),#40);`,
    `#45=IFCQUANTITYLENGTH('Len',$,${unit},2.5,$);`,
    "#44=IFCQUANTITYLENGTH('MilliLen',$,#4,2500.,$);",
    `#46=IFCELEMENTQUANTITY('${gid(46)}',$,'Qto_Probe',$,$,(#45,#44));`,
    `#47=IFCRELDEFINESBYPROPERTIES('${gid(47)}',$,$,$,(#10),#46);`,
    'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n');
  return bufferOf(text);
}

function bufferOf(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

const parse = (assignment: string, unit: string) =>
  new IfcParser().parseColumnar(model(assignment, unit), { disableWorkerScan: true });

/**
 * Wall #10 with `Speed` (own Unit #60) in a project whose assignment lists metre
 * #2, second #5 and #60. #60 is the flat LINEARVELOCITYUNIT from the review of
 * #7547: `pairs` cancelling metre (+1, -1) pairs, then metre +1 and second -1,
 * each element its own entity. Read through the project units and the property.
 */
async function readFlat(pairs: number) {
  const elements: Array<[number, number]> = [];
  for (let i = 0; i < pairs; i++) elements.push([2, 1], [2, -1]);
  elements.push([2, 1], [5, -1]);
  const text = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    "FILE_NAME('flat-unit.ifc','2026-10-13T00:00:00',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
    `#1=IFCPROJECT('${gid(1)}',$,'P',$,$,$,$,$,#3);`,
    '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);', '#3=IFCUNITASSIGNMENT((#2,#5,#60));', '#5=IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.);',
    `#10=IFCWALL('${gid(10)}',$,'W',$,$,$,$,$,$);`,
    `#60=IFCDERIVEDUNIT((${elements.map((_, i) => `#${100 + i}`).join(',')}),.LINEARVELOCITYUNIT.,$);`,
    ...elements.map(([unit, exponent], i) => `#${100 + i}=IFCDERIVEDUNITELEMENT(#${unit},${exponent});`),
    "#35=IFCPROPERTYSINGLEVALUE('Speed',$,IFCLINEARVELOCITYMEASURE(2.5),#60);",
    `#40=IFCPROPERTYSET('${gid(40)}',$,'Probe_Set',$,(#35));`,
    `#41=IFCRELDEFINESBYPROPERTIES('${gid(41)}',$,$,$,(#10),#40);`,
    'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n');
  const store = await new IfcParser().parseColumnar(bufferOf(text), { disableWorkerScan: true });
  return {
    assigned: extractProjectUnits(store.source, store.entityIndex).unitForMeasure('IfcLinearVelocityMeasure'),
    speed: extractPropertiesOnDemand(store, 10).find((s) => s.name === 'Probe_Set')?.properties.find((p) => p.name === 'Speed'),
  };
}

/** Every element of `readFlat(pairs)` in order, nothing cancelled. */
const flatSymbol = (pairs: number) => `${'m·'.repeat(pairs)}m/(${'m·'.repeat(pairs)}s)`;

/**
 * Wall #10 with `Speed` (own Unit #60) in a project whose assignment lists metre
 * #2 and #60. #60 is a LINEARVELOCITYUNIT of `w` elements (#1000 on). Each
 * names `unit` with exponent 1, and `rows` hold what they name. `listed`
 * replaces the element ids in #60's list.
 */
async function parseWide(schema: string, w: number, unit: string, rows: string[], listed?: number[]) {
  const elements = Array.from({ length: w }, (_, i) => 1000 + i);
  const text = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    "FILE_NAME('wide-unit.ifc','2026-10-13T00:00:00',(''),(''),'','','');", `FILE_SCHEMA(('${schema}'));`, 'ENDSEC;', 'DATA;',
    `#1=IFCPROJECT('${gid(1)}',$,'P',$,$,$,$,$,#3);`,
    '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);', '#3=IFCUNITASSIGNMENT((#2,#60));',
    `#10=IFCWALL('${gid(10)}',$,'W',$,$,$,$,$${schema === 'IFC2X3' ? '' : ',$'});`,
    `#60=IFCDERIVEDUNIT((${(listed ?? elements).map((e) => `#${e}`).join(',')}),.LINEARVELOCITYUNIT.,$);`,
    ...elements.map((e) => `#${e}=IFCDERIVEDUNITELEMENT(${unit},1);`),
    ...rows,
    "#35=IFCPROPERTYSINGLEVALUE('Speed',$,IFCLINEARVELOCITYMEASURE(2.5),#60);",
    `#40=IFCPROPERTYSET('${gid(40)}',$,'Probe_Set',$,(#35));`,
    `#41=IFCRELDEFINESBYPROPERTIES('${gid(41)}',$,$,$,(#10),#40);`,
    'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n');
  return new IfcParser().parseColumnar(bufferOf(text), { disableWorkerScan: true });
}

type Store = Awaited<ReturnType<typeof parseWide>>;
const speedOf = (store: Store) =>
  extractPropertiesOnDemand(store, 10).find((s) => s.name === 'Probe_Set')?.properties.find((p) => p.name === 'Speed');

/** What `body` returns, and how often it read entity `id` through any EntityExtractor. */
function readsOf<T>(id: number, body: () => T): [T, number] {
  const decode = vi.spyOn(EntityExtractor.prototype, 'extractEntity');
  try {
    const out = body();
    return [out, decode.mock.calls.filter(([ref]) => ref.expressId === id).length];
  } finally {
    decode.mockRestore();
  }
}

/** Run `body` while `Array.prototype.join` refuses a result over `limit` characters, as V8 does past its string limit. */
function withStringLimit<T>(limit: number, body: () => T): T {
  const join = Array.prototype.join;
  const spy = vi.spyOn(Array.prototype, 'join').mockImplementation(function (this: unknown[], separator?: string) {
    const out = join.call(this, separator);
    if (out.length > limit) throw new RangeError('Invalid string length');
    return out;
  });
  try {
    return body();
  } finally {
    spy.mockRestore();
  }
}

describe('a self-referencing derived unit in a parsed model (#7547)', () => {
  it('as a property own Unit: reported unresolved, the other properties read as before', async () => {
    const store = await parse('#2', '#50');
    const set = extractPropertiesOnDemand(store, 10).find((s) => s.name === 'Probe_Set');
    const byName = new Map(set?.properties.map((p) => [p.name, p]));
    // The STEP reference with no scale, as for any Unit this reader cannot resolve (#4833).
    expect(byName.get('Looped')).toMatchObject({ value: 2.5, unit: '#50' });
    expect(byName.get('Looped')?.unitSiScale).toBeUndefined();
    expect(byName.get('Milli')).toMatchObject({ value: 2500, unit: 'mm', unitSiScale: 0.001 });
    expect(byName.get('Plain')?.unit).toBeUndefined();
  });

  it('as a quantity own Unit: marked unresolved, never the project scale', async () => {
    const store = await parse('#2', '#50');
    const set = extractQuantitiesOnDemand(store, 10).find((s) => s.name === 'Qto_Probe');
    const byName = new Map(set?.quantities.map((q) => [q.name, q]));
    expect(byName.get('Len')).toMatchObject({ value: 2.5, explicitUnitUnresolved: true });
    expect(byName.get('Len')?.explicitUnitSiScale).toBeUndefined();
    expect(byName.get('MilliLen')).toMatchObject({ value: 2500, explicitUnit: 'mm', explicitUnitSiScale: 0.001 });
  });

  it('in the project unit assignment: skipped, and the declared metre still resolves', async () => {
    const store = await parse('#2,#50', '$');
    const units = extractProjectUnits(store.source, store.entityIndex);
    expect(units.resolvedForUnitType('LENGTHUNIT')).toEqual({ symbol: 'm', siScale: 1 });
    expect(units.resolvedForUnitType('USERDEFINED')).toBeUndefined();
    expect(units.declaredCount).toBe(1);
  });
});

describe('a flat derived unit in a parsed model resolves at any width, as before the bound (#7547)', () => {
  it("the review's example, 128 elements, reads as m/s at scale 1, as its two-element control does", async () => {
    const control = await readFlat(0);
    expect(control.assigned).toEqual({ symbol: 'm/s', siScale: 1 });
    expect(control.speed).toMatchObject({ value: 2.5, unit: 'm/s', unitSiScale: 1 });
    const wide = await readFlat(63);
    expect(wide.assigned).toEqual({ symbol: flatSymbol(63), siScale: 1 });
    expect(wide.speed).toMatchObject({ value: 2.5, unit: flatSymbol(63), unitSiScale: 1 });
  });

  it('a flat unit of 10,000 elements reads the same way', async () => {
    const wide = await readFlat(4_999);
    expect(wide.assigned).toEqual({ symbol: flatSymbol(4_999), siScale: 1 });
    expect(wide.speed).toMatchObject({ value: 2.5, unit: flatSymbol(4_999), unitSiScale: 1 });
  });
});

describe('a wide unit over an entity the schema does not allow there, in a parsed model (#7547)', () => {
  it('each element whose Unit names one non-unit entity is charged: it is read 256 times per reader, not 1,000', async () => {
    const store = await parseWide('IFC4', 1_000, '#20', ['#20=IFCCARTESIANPOINT((0.,0.,0.));']);
    const [speed, speedReads] = readsOf(20, () => speedOf(store));
    expect(speedReads).toBe(256);
    // Reported as before: no element resolves, so the unit never did.
    expect(speed).toMatchObject({ value: 2.5, unit: '#60' });
    expect(speed?.unitSiScale).toBeUndefined();
    const [units, unitReads] = readsOf(20, () => extractProjectUnits(store.source, store.entityIndex));
    expect(unitReads).toBe(256);
    expect(units.declaredCount).toBe(1);
  });

  it('an element listed 1,000 times is charged after its first read: 257 reads per reader, then unresolved', async () => {
    // `Elements` is a SET, so a real unit never lists one element twice. Main composed 1,000 metres.
    const store = await parseWide('IFC4', 1, '#2', [], Array(1_000).fill(1000));
    const [speed, speedReads] = readsOf(1000, () => speedOf(store));
    expect(speedReads).toBe(257);
    expect(speed).toMatchObject({ value: 2.5, unit: '#60' });
    expect(speed?.unitSiScale).toBeUndefined();
    const [units, unitReads] = readsOf(1000, () => extractProjectUnits(store.source, store.entityIndex));
    expect(unitReads).toBe(257);
    // Declared, without a scale (#4690): some elements composed before the refusal.
    expect(units.declaredCount).toBe(2);
    expect(units.unitForMeasure('IfcLinearVelocityMeasure')).toBeNull();
  });
});

describe('inside the top-level unit, each reader makes a free read once per walk, in a parsed model (#7547)', () => {
  it('1,000 elements over one metre read it once per reader', async () => {
    const store = await parseWide('IFC4', 1_000, '#20', ['#20=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);']);
    const [speed, speedReads] = readsOf(20, () => speedOf(store));
    expect(speedReads).toBe(1);
    expect(speed).toMatchObject({ value: 2.5, unit: Array(1_000).fill('m').join('·'), unitSiScale: 1 });
    const [units, unitReads] = readsOf(20, () => extractProjectUnits(store.source, store.entityIndex));
    expect(unitReads).toBe(1);
    expect(units.unitForMeasure('IfcLinearVelocityMeasure')?.symbol).toBe(Array(1_000).fill('m').join('·'));
  });

  it('300 elements over one foot whose factor holds a 65,536-character IfcText read that factor once per reader', async () => {
    // IfcMeasureWithUnit.ValueComponent is an IfcValue, and IfcText has no length limit in IFC4, so
    // the factor can be any size. Main read it once per element. A text value is not a number, so
    // FOOT's known factor applies, as before.
    const store = await parseWide('IFC4', 300, '#20', [
      "#20=IFCCONVERSIONBASEDUNIT(#23,.LENGTHUNIT.,'FOOT',#21);", '#23=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);',
      `#21=IFCMEASUREWITHUNIT(IFCTEXT('${'T'.repeat(65_536)}'),#2);`,
    ]);
    const feet = Array(300).fill('ft').join('·');
    const [speed, speedReads] = readsOf(21, () => speedOf(store));
    expect(speedReads).toBe(1);
    expect(speed?.unit).toBe(feet);
    const [units, unitReads] = readsOf(21, () => extractProjectUnits(store.source, store.entityIndex));
    expect(unitReads).toBe(1);
    expect(units.unitForMeasure('IfcLinearVelocityMeasure')?.symbol).toBe(feet);
  });
});

describe('a chain of nested derived units read through a native view (#7547)', () => {
  /** Wall type #20 owns quantity set #21; its IfcQuantityLength `Len` has as own Unit a chain of `n` derived units over a metre. */
  async function typeQuantity(n: number) {
    const chain: string[] = [];
    for (let i = 0; i < n; i++) {
      const unit = 100 + 2 * i;
      chain.push(`#${unit}=IFCDERIVEDUNIT((#${unit + 1}),.LENGTHUNIT.,$);`, `#${unit + 1}=IFCDERIVEDUNITELEMENT(#${unit + 2},1);`);
    }
    const text = [
      'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
      "FILE_NAME('type-quantity.ifc','2026-10-14T00:00:00',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
      `#1=IFCPROJECT('${gid(1)}',$,'P',$,$,$,$,$,#3);`, '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);', '#3=IFCUNITASSIGNMENT((#2));',
      `#20=IFCWALLTYPE('${gid(20)}',$,'WT',$,$,(#21),$,$,$,.STANDARD.);`,
      `#21=IFCELEMENTQUANTITY('${gid(21)}',$,'Qto_Probe',$,$,(#22));`,
      "#22=IFCQUANTITYLENGTH('Len',$,#100,2.5,$);",
      ...chain, `#${100 + 2 * n}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`,
      'ENDSEC;', 'END-ISO-10303-21;',
    ].join('\n');
    return new IfcParser().parseColumnar(bufferOf(text), { disableWorkerScan: true });
  }
  /** A view with no edits: the current-model readers then read the parsed records. */
  const NO_EDITS: MetadataReadView = {
    isDeleted: () => false, getNewEntities: () => [], getNewEntity: () => null,
    getPositionalMutationsForEntity: () => null, getAttributeMutationsForEntity: () => [], getMutationRevision: () => 0,
  };

  it("16 levels resolve as on main, within the reader's own 512-read limit; the source path refuses them at the depth cap", async () => {
    const store = await typeQuantity(16);
    const native = extractTypeEntityOwnQuantities(store, 20, NO_EDITS).flatMap((set) => set.quantities);
    expect(native).toHaveLength(1);
    expect(native[0]).toMatchObject({ value: 2.5, explicitUnit: 'm', explicitUnitSiScale: 1 });
    const source = extractTypeEntityOwnQuantities(store, 20).flatMap((set) => set.quantities);
    expect(source[0]).toMatchObject({ value: 2.5, explicitUnitUnresolved: true });
    expect(source[0]?.explicitUnit).toBeUndefined();
  });
});

describe("a flat unit whose symbol passes the engine's string limit, in a parsed model (#7547)", () => {
  // IFC2X3 sets no length on IfcLabel. 30 elements over one conversion-based unit named by 20
  // X's make a 629-character symbol, one Array.prototype.join; the stand-in limit is 600.
  const named = [
    `#20=IFCCONVERSIONBASEDUNIT(#21,.LENGTHUNIT.,'${'X'.repeat(20)}',#22);`,
    '#21=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);', '#22=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#2);',
  ];

  it('is reported unresolved by both readers, where main threw RangeError', async () => {
    const store = await parseWide('IFC2X3', 30, '#20', named);
    expect(extractProjectUnits(store.source, store.entityIndex).unitForMeasure('IfcLinearVelocityMeasure')?.symbol).toHaveLength(629);
    const units = withStringLimit(600, () => extractProjectUnits(store.source, store.entityIndex));
    // Declared, without a scale, so it shows no unit rather than the SI default (#4690).
    expect(units.declaredCount).toBe(2);
    expect(units.unitForMeasure('IfcLinearVelocityMeasure')).toBeNull();
    expect(units.resolvedForUnitType('LENGTHUNIT')).toEqual({ symbol: 'm', siScale: 1 });
    const speed = withStringLimit(600, () => speedOf(store));
    expect(speed).toMatchObject({ value: 2.5, unit: '#60' });
    expect(speed?.unitSiScale).toBeUndefined();
  });
});

// A committed exporter file whose IfcUnitAssignment lists 25 units, nine of them
// IfcDerivedUnits of up to four elements: the bound must not bind on real output.
const EXPORTER_FILE = fileURLToPath(new URL('../../../rust/geometry/tests/fixtures/issue_098_wall_V5C.ifc', import.meta.url));

// Committed, so a missing file fails here rather than skipping the control.
describe('derived units from a real exporter stay inside the bound (#7547)', () => {
  it('every derived unit in the assignment resolves', async () => {
    const bytes = readFileSync(EXPORTER_FILE);
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const store = await new IfcParser().parseColumnar(buffer, { disableWorkerScan: true });
    const units = extractProjectUnits(store.source, store.entityIndex);
    // 25 members, two of them USERDEFINED: the first of a unit type is kept.
    expect(units.declaredCount).toBe(24);
    // Each derived unit resolves to its SI scale; the composed symbol text is
    // not this bound's business, so it is not pinned here.
    for (const unitType of [
      'MASSDENSITYUNIT', 'MOMENTOFINERTIAUNIT', 'THERMALTRANSMITTANCEUNIT', 'VOLUMETRICFLOWRATEUNIT',
      'USERDEFINED', 'LINEARVELOCITYUNIT', 'LINEARFORCEUNIT', 'PLANARFORCEUNIT',
    ]) {
      const resolved = units.resolvedForUnitType(unitType);
      expect(resolved?.symbol, unitType).toBeTruthy();
      expect(resolved?.siScale, unitType).toBe(1);
    }
  });
});
