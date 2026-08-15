/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Zone assignment written into the model, and out again through a STEP export
 * (#2508 item 3).
 *
 * The claim under test is not "a pset object appeared in a map". It is that a
 * file handed to someone else carries the zone assignment, in that file's own
 * units, with the basis named. So the assertions re-PARSE the exported STEP
 * wherever they can, following the rule `overlay-effective-model.test.ts`
 * states: asserting on the overlay proves the writer wrote what it meant to;
 * re-parsing proves the file means it.
 *
 * Everything here runs against a REAL columnar store parsed from inline STEP,
 * including a real declared VOLUMEUNIT, because the unit conversion is the one
 * thing a stub would silently make vacuous.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  IfcParser,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { useViewerStore } from '@/store/index.js';
import { applyZoneWriteBack, removeZoneWriteBack } from './useZoneWriteBack.js';
import {
  zonePropertySetName,
  zoneQuantitySetName,
  ZONE_PROPERTY_NAMES,
  type ZoneApportionmentEntry,
  type ZoneSet,
} from '@/lib/zones';

const WALL_ID = 42;
const BEAM_ID = 43;

/** A file that declares CUBIC MILLIMETRE volumes, so a value written as if it
 *  were cubic metres is wrong by 1e9 and cannot pass by luck. `#42` also
 *  carries a declared NetVolume of 2e9 mm3 (2 m3). */
function miniIfc(volumeUnitPrefix: string): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('zones','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,(#5),#6);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCSIUNIT(*,.VOLUMEUNIT.,${volumeUnitPrefix},.CUBIC_METRE.);
#6=IFCUNITASSIGNMENT((#2,#3));
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,$,$);
#${WALL_ID}=IFCWALL('0Wall00000000000000042',$,'Wall A',$,$,$,$,$,$);
#${BEAM_ID}=IFCBEAM('0Beam00000000000000043',$,'Beam B',$,$,$,$,$,$);
#50=IFCQUANTITYVOLUME('NetVolume',$,$,2.E+09,$);
#51=IFCELEMENTQUANTITY('0Qto000000000000000051',$,'Qto_WallBaseQuantities',$,$,(#50));
#52=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000052',$,$,$,(#${WALL_ID}),#51);
ENDSEC;
END-ISO-10303-21;
`;
}

async function parse(ifc: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ifc);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

const ZONE_SET: ZoneSet = {
  id: 'set-1',
  name: 'Takt areas',
  zones: [
    { id: 'z-a', name: 'Takt A', center: [0, 0, 0], size: [10, 10, 10], rotationY: 0 },
    { id: 'z-b', name: 'Takt B', center: [10, 0, 0], size: [10, 10, 10], rotationY: 0 },
  ],
  visible: true,
  createdAt: 0,
  updatedAt: 0,
};

/** #42 straddles A/B 40/60; #43 sits wholly in A. */
function seedAssignments() {
  return new Map([
    [WALL_ID, { 'set-1': { zoneId: 'z-a', zoneName: 'Takt A', straddles: true, touchedZoneIds: ['z-a', 'z-b'] } }],
    [BEAM_ID, { 'set-1': { zoneId: 'z-a', zoneName: 'Takt A', straddles: false, touchedZoneIds: ['z-a'] } }],
  ]);
}

/** A cache entry as `computeZoneApportionmentNow` would leave it, so the write
 *  path reads the SAME source the panel and the Lists columns read rather than
 *  re-deriving one for the test. */
function seedApportionment(revision: string): Map<string, ZoneApportionmentEntry> {
  return new Map([['set-1', {
    revision,
    byElement: new Map([[WALL_ID, {
      wholeVolumeM3: 5,
      shares: [
        { zoneId: 'z-a', zoneName: 'Takt A', volumeM3: 2, fraction: 0.4 },
        { zoneId: 'z-b', zoneName: 'Takt B', volumeM3: 3, fraction: 0.6 },
      ],
      outsideVolumeM3: 0,
      outsideFraction: 0,
      overlapping: false,
      unreliable: false,
    }]]),
    refused: new Map(),
    computedAt: 0,
    elapsedMs: 1,
  }]]);
}

async function seedStore(volumeUnitPrefix = '.MILLI.'): Promise<IfcDataStore> {
  const store = await parse(miniIfc(volumeUnitPrefix));
  const { zoneSetRevision } = await import('@/lib/zones');
  useViewerStore.setState({
    models: new Map([['m1', {
      id: 'm1',
      name: 'zones.ifc',
      ifcDataStore: store,
      visible: true,
    } as never]]),
    zoneSets: [ZONE_SET],
    zoneAssignments: seedAssignments() as never,
    zoneApportionment: seedApportionment(zoneSetRevision(ZONE_SET)),
    mutationViews: new Map(),
    dirtyModels: new Set(),
  } as never);
  return store;
}

function view() {
  return useViewerStore.getState().getMutationView('m1');
}

function psetOn(entityId: number, name: string) {
  return view()?.getForEntity(entityId).find((p) => p.name === name) ?? null;
}

function qsetOn(entityId: number, name: string) {
  return view()?.getQuantitiesForEntity(entityId).find((q) => q.name === name) ?? null;
}

describe('zone write-back: what reaches the model', () => {
  beforeEach(async () => {
    await seedStore();
  });

  it('writes the classification onto a straddler and a non-straddler alike', () => {
    const result = applyZoneWriteBack(ZONE_SET, 'mesh');
    assert.equal(result.blocked, null);
    assert.equal(result.summary.written, 2);

    const pset = psetOn(WALL_ID, zonePropertySetName('Takt areas'));
    assert.ok(pset, 'straddler got no property set');
    const props = new Map(pset.properties.map((p) => [p.name, p.value]));
    assert.equal(props.get(ZONE_PROPERTY_NAMES.zone), 'Takt A');
    assert.equal(props.get(ZONE_PROPERTY_NAMES.zones), 'Takt A, Takt B');
    assert.equal(props.get(ZONE_PROPERTY_NAMES.straddles), true);

    const beam = psetOn(BEAM_ID, zonePropertySetName('Takt areas'));
    assert.ok(beam, 'non-straddler got no property set');
    assert.equal(
      new Map(beam.properties.map((p) => [p.name, p.value])).get(ZONE_PROPERTY_NAMES.straddles),
      false,
    );
  });

  it('converts the apportioned volumes into the file\'s declared unit', () => {
    applyZoneWriteBack(ZONE_SET, 'mesh');
    const qset = qsetOn(WALL_ID, zoneQuantitySetName('Takt areas', 'mesh'));
    assert.ok(qset, 'no quantity set was written');
    const values = new Map(qset.quantities.map((q) => [q.name, q.value]));
    // 2 m3 and 3 m3 in a file that declares CUBIC MILLIMETRES. Writing 2 and 3
    // would state two and three cubic millimetres.
    assert.ok(Math.abs((values.get('Takt A') ?? 0) / 2e9 - 1) < 1e-9, `Takt A = ${values.get('Takt A')}`);
    assert.ok(Math.abs((values.get('Takt B') ?? 0) / 3e9 - 1) < 1e-9, `Takt B = ${values.get('Takt B')}`);
  });

  it('leaves the same numbers unscaled in a file that declares cubic metres', async () => {
    await seedStore('$');
    applyZoneWriteBack(ZONE_SET, 'mesh');
    const values = new Map(
      (qsetOn(WALL_ID, zoneQuantitySetName('Takt areas', 'mesh'))?.quantities ?? []).map((q) => [q.name, q.value]),
    );
    assert.equal(values.get('Takt A'), 2);
    assert.equal(values.get('Takt B'), 3);
  });

  it('marks the model dirty, so the session reports the unsaved change', () => {
    applyZoneWriteBack(ZONE_SET, 'mesh');
    assert.ok(useViewerStore.getState().dirtyModels.has('m1'));
  });

  it('splits a DECLARED quantity by the measured fractions, and names it', () => {
    applyZoneWriteBack(ZONE_SET, 'net');
    const qset = qsetOn(WALL_ID, zoneQuantitySetName('Takt areas', 'net'));
    assert.ok(qset, 'no net quantity set');
    const values = new Map(qset.quantities.map((q) => [q.name, q.value]));
    // Declared NetVolume is 2e9 mm3; the split is 40/60 measured on the mesh.
    assert.ok(Math.abs((values.get('Takt A') ?? 0) / 0.8e9 - 1) < 1e-9, `${values.get('Takt A')}`);
    assert.ok(Math.abs((values.get('Takt B') ?? 0) / 1.2e9 - 1) < 1e-9, `${values.get('Takt B')}`);
    // Summing to the declared total by construction is the whole point of the
    // declared basis: the user already trusts that number.
    const total = [...values.values()].reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total / 2e9 - 1) < 1e-9, `net shares summed to ${total}`);

    const props = new Map((psetOn(WALL_ID, zonePropertySetName('Takt areas'))?.properties ?? [])
      .map((p) => [p.name, p.value]));
    assert.equal(props.get(ZONE_PROPERTY_NAMES.volumeBasis), 'net');
    assert.equal(props.get(ZONE_PROPERTY_NAMES.volumeQuantity), 'NetVolume');
  });

  it('refuses rather than falling back when the element declares nothing on that basis', () => {
    // The beam carries no quantities at all, so a `net` run has nothing to
    // apportion for it. Falling back to its mesh volume would put a mesh number
    // inside a quantity set named net.
    applyZoneWriteBack(ZONE_SET, 'net');
    assert.equal(qsetOn(BEAM_ID, zoneQuantitySetName('Takt areas', 'net')), null);
    const props = new Map((psetOn(BEAM_ID, zonePropertySetName('Takt areas'))?.properties ?? [])
      .map((p) => [p.name, p.value]));
    assert.match(String(props.get(ZONE_PROPERTY_NAMES.volumeUnavailable)), /declares no volume quantity/);
  });

  it('switching basis replaces the previous run rather than stacking one set per basis', () => {
    applyZoneWriteBack(ZONE_SET, 'mesh');
    applyZoneWriteBack(ZONE_SET, 'net');
    const all = (view()?.getQuantitiesForEntity(WALL_ID) ?? [])
      .filter((q) => q.name.startsWith('IfcLite_ZoneVolumes'));
    assert.deepEqual(all.map((q) => q.name), [zoneQuantitySetName('Takt areas', 'net')]);
  });

  it('a re-run that can no longer state a volume clears the numbers it stated before', () => {
    // The contradiction this prevents: the property set says the volume could
    // not be computed while a quantity set beside it still carries the previous
    // run's cubic metres. Reached here by moving a zone, which invalidates the
    // apportionment cache by revision; with no renderer in this runner, the
    // recompute refuses.
    applyZoneWriteBack(ZONE_SET, 'mesh');
    assert.ok(qsetOn(WALL_ID, zoneQuantitySetName('Takt areas', 'mesh')));

    const moved: ZoneSet = {
      ...ZONE_SET,
      zones: [{ ...ZONE_SET.zones[0], center: [1, 0, 0] as [number, number, number] }, ZONE_SET.zones[1]],
    };
    applyZoneWriteBack(moved, 'mesh');

    assert.equal(qsetOn(WALL_ID, zoneQuantitySetName('Takt areas', 'mesh')), null);
    const props = new Map((psetOn(WALL_ID, zonePropertySetName('Takt areas'))?.properties ?? [])
      .map((p) => [p.name, p.value]));
    assert.equal(props.get(ZONE_PROPERTY_NAMES.volumeUnavailable) !== undefined, true);
  });

  it('never reads its own output back as a declared quantity', () => {
    // An `unqualified` run writes volume quantities with no qualifying name.
    // Read back on the next run they would look like the element's declared
    // total, so each run would apportion the previous run's shares again.
    // The WALL on its declared NET basis: the beam declares no quantities at
    // all, so any declared-basis run refuses it and both reads would be null -
    // the assertion would then hold for a run that wrote nothing.
    applyZoneWriteBack(ZONE_SET, 'net');
    const first = qsetOn(WALL_ID, zoneQuantitySetName('Takt areas', 'net'));
    assert.ok(first && first.quantities.length > 0, 'the first run wrote nothing to compare');
    applyZoneWriteBack(ZONE_SET, 'net');
    const second = qsetOn(WALL_ID, zoneQuantitySetName('Takt areas', 'net'));
    assert.ok(second);
    assert.deepEqual(
      second.quantities.map((q) => q.value),
      first.quantities.map((q) => q.value),
    );
  });

  it('removes what it wrote', () => {
    applyZoneWriteBack(ZONE_SET, 'mesh');
    const { removed } = removeZoneWriteBack(ZONE_SET);
    assert.equal(removed, 2);
    assert.equal(psetOn(WALL_ID, zonePropertySetName('Takt areas')), null);
  });
});

describe('zone write-back: the exported file carries it', () => {
  beforeEach(async () => {
    await seedStore();
  });

  it('survives a STEP export and re-parse, with the value still in file units', async () => {
    applyZoneWriteBack(ZONE_SET, 'mesh');
    const store = useViewerStore.getState().models.get('m1')!.ifcDataStore as IfcDataStore;
    const exported = new StepExporter(store, view()!).export({
      schema: 'IFC4',
      visibleOnly: false,
      hiddenEntityIds: new Set<number>(),
    });

    const reparsed = await parse(new TextDecoder().decode(exported.content));
    // Through the ON-DEMAND extractors, which is how the viewer itself reads a
    // lazily-parsed model: the `properties` / `quantities` tables are empty
    // until something asks, so reading them directly would assert nothing.
    const psets = extractPropertiesOnDemand(reparsed, WALL_ID);
    const zonePset = psets.find((p) => p.name === zonePropertySetName('Takt areas'));
    assert.ok(zonePset, `zone pset missing from the export; got ${psets.map((p) => p.name).join(', ')}`);
    const props = new Map(zonePset.properties.map((p) => [p.name, p.value]));
    assert.equal(props.get(ZONE_PROPERTY_NAMES.zones), 'Takt A, Takt B');
    assert.equal(props.get(ZONE_PROPERTY_NAMES.straddles), true);

    const qsets = extractQuantitiesOnDemand(reparsed, WALL_ID);
    const zoneQset = qsets.find((q) => q.name === zoneQuantitySetName('Takt areas', 'mesh'));
    assert.ok(zoneQset, `zone qset missing from the export; got ${qsets.map((q) => q.name).join(', ')}`);
    const values = new Map(zoneQset.quantities.map((q) => [q.name, q.value]));
    assert.ok(Math.abs((values.get('Takt A') ?? 0) / 2e9 - 1) < 1e-6, `Takt A = ${values.get('Takt A')}`);
  });
});

describe('zone write-back: what a later run has to clean up', () => {
  beforeEach(async () => {
    await seedStore();
  });

  it('an element that has LEFT the set loses what the last run wrote onto it', () => {
    applyZoneWriteBack(ZONE_SET, 'mesh');
    assert.ok(psetOn(BEAM_ID, zonePropertySetName('Takt areas')));

    // The zone moved away, so the beam is in no zone of the set any more. The
    // old run's "Zone: Takt A" would otherwise stay on it forever: nothing else
    // visits an element that is no longer a member.
    useViewerStore.setState({
      zoneAssignments: new Map([
        [WALL_ID, { 'set-1': { zoneId: 'z-a', zoneName: 'Takt A', straddles: true, touchedZoneIds: ['z-a', 'z-b'] } }],
        [BEAM_ID, { 'set-1': { zoneId: null, zoneName: null, straddles: false, touchedZoneIds: [] } }],
      ]) as never,
    } as never);
    applyZoneWriteBack(ZONE_SET, 'mesh');

    assert.equal(psetOn(BEAM_ID, zonePropertySetName('Takt areas')), null);
    assert.equal(qsetOn(BEAM_ID, zoneQuantitySetName('Takt areas', 'mesh')), null);
  });

  it('renaming the set does not strand the sets written under the old name', () => {
    // The set names carry the DISPLAY name, so a run after a rename writes to
    // new names. Matching the old output by name would miss it; the property
    // set carries the set's stable id for exactly this.
    applyZoneWriteBack(ZONE_SET, 'mesh');
    applyZoneWriteBack({ ...ZONE_SET, name: 'Sections' }, 'mesh');

    const names = (view()?.getForEntity(WALL_ID) ?? []).map((p) => p.name)
      .filter((n) => n.startsWith('IfcLite_Zones'));
    assert.deepEqual(names, ['IfcLite_Zones [Sections]']);
    const qnames = (view()?.getQuantitiesForEntity(WALL_ID) ?? []).map((q) => q.name)
      .filter((n) => n.startsWith('IfcLite_ZoneVolumes'));
    assert.deepEqual(qnames, [zoneQuantitySetName('Sections', 'mesh')]);
  });

  it('removing reports nothing, and dirties nothing, on a model never written to', () => {
    // `deletePropertySet` returns a mutation whether or not anything was there,
    // so counting calls rather than deletions claimed an edit over a
    // byte-identical model and offered to save it.
    const { removed } = removeZoneWriteBack(ZONE_SET);
    assert.equal(removed, 0);
    assert.equal(useViewerStore.getState().dirtyModels.has('m1'), false);
  });

  it('removing reaches an element that has since left the set', () => {
    applyZoneWriteBack(ZONE_SET, 'mesh');
    useViewerStore.setState({
      zoneAssignments: new Map([
        [WALL_ID, { 'set-1': { zoneId: null, zoneName: null, straddles: false, touchedZoneIds: [] } }],
        [BEAM_ID, { 'set-1': { zoneId: null, zoneName: null, straddles: false, touchedZoneIds: [] } }],
      ]) as never,
    } as never);

    const { removed } = removeZoneWriteBack(ZONE_SET);
    assert.equal(removed, 2);
    assert.equal(psetOn(WALL_ID, zonePropertySetName('Takt areas')), null);
  });

  it('refuses to write when another zone set has the same display name', () => {
    // Both set names carry the display name, so two sets sharing one would
    // write to the same property set and each sweep would clear the other's
    // quantity sets.
    useViewerStore.setState({
      zoneSets: [ZONE_SET, { ...ZONE_SET, id: 'set-2' }],
    } as never);
    const result = applyZoneWriteBack(ZONE_SET, 'mesh');
    assert.equal(result.blocked, 'duplicate-set-name');
    assert.equal(result.summary.written, 0);
    assert.equal(view(), null, 'nothing was written at all');
  });

  it('says WHY a removal did nothing, rather than reporting an empty success', () => {
    // "Nothing to remove" and "you were not allowed to" are different answers,
    // and only one of them means the user should do something next.
    useViewerStore.setState({
      zoneSets: [ZONE_SET, { ...ZONE_SET, id: 'set-2' }],
    } as never);
    assert.equal(removeZoneWriteBack(ZONE_SET).blocked, 'duplicate-set-name');
  });

  it('removes from an element the assignment cache no longer holds', () => {
    // Geometry released to reclaim memory (#2183) drops the element from
    // `zoneAssignments`, but not its property set. The session's own mutation
    // history still names every element it wrote to.
    applyZoneWriteBack(ZONE_SET, 'mesh');
    useViewerStore.setState({ zoneAssignments: new Map() } as never);

    const { removed } = removeZoneWriteBack(ZONE_SET);
    assert.equal(removed, 2);
    assert.equal(psetOn(WALL_ID, zonePropertySetName('Takt areas')), null);
    assert.equal(psetOn(BEAM_ID, zonePropertySetName('Takt areas')), null);
  });

  it('does not touch another zone set\'s output', () => {
    applyZoneWriteBack(ZONE_SET, 'mesh');
    const other: ZoneSet = { ...ZONE_SET, id: 'set-2', name: 'Sections' };
    useViewerStore.setState({
      zoneAssignments: new Map([
        [WALL_ID, {
          'set-1': { zoneId: 'z-a', zoneName: 'Takt A', straddles: true, touchedZoneIds: ['z-a', 'z-b'] },
          'set-2': { zoneId: 'z-a', zoneName: 'Takt A', straddles: false, touchedZoneIds: ['z-a'] },
        }],
      ]) as never,
    } as never);
    applyZoneWriteBack(other, 'mesh');

    // Both sets coexist: an element genuinely belongs to several zone sets at
    // once, which is v1's whole point.
    const names = (view()?.getForEntity(WALL_ID) ?? []).map((p) => p.name)
      .filter((n) => n.startsWith('IfcLite_Zones')).sort();
    assert.deepEqual(names, ['IfcLite_Zones [Sections]', 'IfcLite_Zones [Takt areas]']);

    removeZoneWriteBack(other);
    const left = (view()?.getForEntity(WALL_ID) ?? []).map((p) => p.name)
      .filter((n) => n.startsWith('IfcLite_Zones'));
    assert.deepEqual(left, ['IfcLite_Zones [Takt areas]']);
  });
});
