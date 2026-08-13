/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Zone sets emitted as `IfcSpatialZone`, and out again through a STEP export
 * (#2508 item 3).
 *
 * Same rule as the write-back's own test: asserting on the overlay proves the
 * writer wrote what it meant to, and re-reading the exported STEP proves the
 * FILE means it. The overlay is where an entity that never reaches the
 * exporter still looks fine, which is exactly the bug class this feature has
 * already produced once (a quantity-set deletion the exporter ignored).
 *
 * The fixture declares MILLIMETRES, because emitting metres into a millimetre
 * file is this feature's characteristic failure in geometric form: a zone a
 * thousand times too small, in the right place, with the right name.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, extractPropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { useViewerStore } from '@/store/index.js';
import { emitZoneSpatialZones, removeZoneSpatialZones } from './useZoneSpatialZones.js';
import type { ZoneSet } from '@/lib/zones';

const WALL_ID = 42;
const BEAM_ID = 43;
const STOREY_ID = 30;

/** A millimetre file with everything `resolveSpatialAnchor` needs: a 3D
 *  representation context, a storey, and a placement under it. */
function miniIfc(schema = 'IFC4', lengthUnit = '.MILLI.'): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('zones','',(''),(''),'','','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',#4,'P',$,$,$,$,(#5),#6);
#2=IFCSIUNIT(*,.LENGTHUNIT.,${lengthUnit},.METRE.);
#4=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);
#6=IFCUNITASSIGNMENT((#2));
#7=IFCCARTESIANPOINT((0.,0.,0.));
#8=IFCAXIS2PLACEMENT3D(#7,$,$);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#8,$);
#20=IFCLOCALPLACEMENT($,#8);
#${STOREY_ID}=IFCBUILDINGSTOREY('0storey000000000000000',#4,'Level 0',$,$,#20,$,$,.ELEMENT.,0.);
#${WALL_ID}=IFCWALL('0Wall00000000000000042',#4,'Wall A',$,$,$,$,$,$);
#${BEAM_ID}=IFCBEAM('0Beam00000000000000043',#4,'Beam B',$,$,$,$,$,$);
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

/** Two zones tiling 0..20 m along X, both 4 m tall from y = 0. */
const ZONE_SET: ZoneSet = {
  id: 'set-1',
  name: 'Takt areas',
  zones: [
    { id: 'z-a', name: 'Takt A', center: [5, 2, 0], size: [10, 4, 8], rotationY: 0 },
    { id: 'z-b', name: 'Takt B', center: [15, 2, 0], size: [10, 4, 8], rotationY: 0 },
  ],
  visible: true,
  createdAt: 0,
  updatedAt: 0,
};

/** #42 straddles both zones; #43 sits in A alone. */
function seedAssignments() {
  return new Map([
    [WALL_ID, { 'set-1': { zoneId: 'z-a', zoneName: 'Takt A', straddles: true, touchedZoneIds: ['z-a', 'z-b'] } }],
    [BEAM_ID, { 'set-1': { zoneId: 'z-a', zoneName: 'Takt A', straddles: false, touchedZoneIds: ['z-a'] } }],
  ]);
}

async function seedStore(options: { schema?: string; lengthUnit?: string; rebased?: boolean } = {}): Promise<IfcDataStore> {
  const store = await parse(miniIfc(options.schema, options.lengthUnit));
  useViewerStore.setState({
    models: new Map([['m1', {
      id: 'm1',
      name: 'zones.ifc',
      ifcDataStore: store,
      visible: true,
      loadedAt: 1,
      // `'same-crs'` is one of the two statuses under which alignment re-baked
      // this model's vertices into another file's frame.
      federationAlignmentStatus: options.rebased ? 'same-crs' : undefined,
    } as never]]),
    zoneSets: [ZONE_SET],
    zoneAssignments: seedAssignments() as never,
    mutationViews: new Map(),
    storeEditors: new Map(),
    dirtyModels: new Set(),
  } as never);
  return store;
}

function overlay() {
  return useViewerStore.getState().getMutationView('m1')?.getNewEntities() ?? [];
}

function zoneEntities() {
  return overlay().filter((e) => e.type === 'IfcSpatialZone');
}

/** Export and hand back the STEP text, so assertions read the FILE. */
function exportStep(store: IfcDataStore): string {
  const view = useViewerStore.getState().getMutationView('m1');
  const result = new StepExporter(store, view as never).export({ schema: 'IFC4', applyMutations: true });
  return new TextDecoder().decode(result.content);
}

describe('emitZoneSpatialZones: what reaches the model', () => {
  let store: IfcDataStore;
  beforeEach(async () => {
    store = await seedStore();
    // The write path needs a real on-demand extractor for the model, same as
    // any other overlay consumer.
    const view = useViewerStore.getState().getMutationView('m1');
    view?.setOnDemandExtractor?.((entityId: number) => extractPropertiesOnDemand(store, entityId));
  });

  it('emits one zone per zone in the set, referencing the elements it holds', () => {
    const result = emitZoneSpatialZones(ZONE_SET);
    assert.equal(result.blocked, null);
    assert.equal(result.models.length, 1);
    assert.equal(result.models[0].refusal, null);
    assert.equal(result.models[0].zonesEmitted, 2);
    // The straddler counts under both zones, the beam under one.
    assert.equal(result.models[0].elementsReferenced, 3);

    const rels = overlay().filter((e) => e.type === 'IfcRelReferencedInSpatialStructure');
    assert.equal(rels.length, 2);
    const a = rels.find((r) => (r.attributes[4] as string[]).includes(`#${BEAM_ID}`));
    assert.deepEqual(a?.attributes[4], [`#${WALL_ID}`, `#${BEAM_ID}`]);
  });

  it('the exported FILE carries the zones, by reference and never by containment', () => {
    emitZoneSpatialZones(ZONE_SET);
    const step = exportStep(store);

    // Nine arguments, the zone's own name in Name and the SET's in LongName:
    // the whole record, so a tenth argument (the `CompositionType` this type
    // does not have) or a swapped name pair cannot pass.
    assert.match(step, /=IFCSPATIALZONE\('.{22}',#4,'Takt A',\$,\$,#\d+,#\d+,'Takt areas',\.CONSTRUCTION\.\);/);
    assert.match(step, /=IFCSPATIALZONE\('.{22}',#4,'Takt B',\$,\$,#\d+,#\d+,'Takt areas',\.CONSTRUCTION\.\);/);
    assert.equal((step.match(/=IFCSPATIALZONE\(/g) ?? []).length, 2);
    assert.match(step, /=IFCRELREFERENCEDINSPATIALSTRUCTURE\(/);
    // Containment is the exclusive relation that carries the building's real
    // hierarchy. Emitting one here would move an element out of its storey.
    assert.doesNotMatch(step, /=IFCRELCONTAINEDINSPATIALSTRUCTURE\(/);
  });

  it('writes the zone in the file\'s own length unit', () => {
    emitZoneSpatialZones(ZONE_SET);
    const step = exportStep(store);
    // Takt A is 10 m x 8 m x 4 m in a MILLIMETRE file.
    assert.match(step, /=IFCRECTANGLEPROFILEDEF\(\.AREA\.,\$,#\d+,10000\.?,8000\.?\)/);
    assert.match(step, /=IFCEXTRUDEDAREASOLID\(#\d+,#\d+,#\d+,4000\.?\)/);
  });

  it('re-parses into a store that has the zones as real entities', async () => {
    emitZoneSpatialZones(ZONE_SET);
    const reparsed = await parse(exportStep(store));
    const ids = reparsed.entityIndex.byType.get('IFCSPATIALZONE') ?? [];
    assert.equal(ids.length, 2, 'the exported file does not parse back into two zones');
    assert.equal((reparsed.entityIndex.byType.get('IFCRELREFERENCEDINSPATIALSTRUCTURE') ?? []).length, 2);
  });
});

describe('emitZoneSpatialZones: running it twice', () => {
  let store: IfcDataStore;
  beforeEach(async () => {
    store = await seedStore();
  });

  it('replaces the previous run rather than stacking a second copy', () => {
    emitZoneSpatialZones(ZONE_SET);
    const second = emitZoneSpatialZones(ZONE_SET);
    assert.equal(second.models[0].zonesReplaced, 2);
    assert.equal(zoneEntities().length, 2, 'a second press left duplicate zones behind');
    assert.equal((exportStep(store).match(/=IFCSPATIALZONE\(/g) ?? []).length, 2);
  });

  it('leaves nothing of the first run behind, not even its geometry', () => {
    emitZoneSpatialZones(ZONE_SET);
    const firstPass = overlay().length;
    emitZoneSpatialZones(ZONE_SET);
    // Every entity is per-zone, so a sweep that only removed the zone itself
    // would leave the points, profiles and solids piling up run after run.
    assert.equal(overlay().length, firstPass);
  });

  it('follows a rename: zones written under the old name are NOT swept', () => {
    // The honest limit of a name-keyed sweep, pinned so it is a decision rather
    // than a surprise. The zone set's name is what a receiving tool reads in
    // LongName, and there is no id in the file to match on instead.
    emitZoneSpatialZones(ZONE_SET);
    const renamed = { ...ZONE_SET, name: 'Sections' };
    const result = emitZoneSpatialZones(renamed);
    assert.equal(result.models[0].zonesReplaced, 0);
    assert.equal(zoneEntities().length, 4);
    // Removing under the old name still reaches the old copies.
    assert.equal(removeZoneSpatialZones(ZONE_SET).removed, 2);
    assert.equal(zoneEntities().length, 2);
  });
});

describe('removeZoneSpatialZones', () => {
  let store: IfcDataStore;
  beforeEach(async () => {
    store = await seedStore();
  });

  it('takes the zones back out of the exported file', () => {
    emitZoneSpatialZones(ZONE_SET);
    const removal = removeZoneSpatialZones(ZONE_SET);
    assert.equal(removal.removed, 2);
    const step = exportStep(store);
    assert.doesNotMatch(step, /=IFCSPATIALZONE\(/);
    assert.doesNotMatch(step, /=IFCRELREFERENCEDINSPATIALSTRUCTURE\(/);
  });

  it('reports nothing removed when nothing was emitted', () => {
    assert.equal(removeZoneSpatialZones(ZONE_SET).removed, 0);
  });

  it('leaves the model\'s own entities alone', () => {
    emitZoneSpatialZones(ZONE_SET);
    removeZoneSpatialZones(ZONE_SET);
    const step = exportStep(store);
    // The elements the zones referenced, and the storey they anchored against,
    // are file entities: a sweep that walked into them would tombstone the
    // model itself.
    assert.match(step, /=IFCWALL\('0Wall00000000000000042'/);
    assert.match(step, /=IFCBEAM\('0Beam00000000000000043'/);
    assert.match(step, /=IFCBUILDINGSTOREY\('0storey000000000000000'/);
  });
});

describe('emitZoneSpatialZones: what it refuses', () => {
  it('refuses a model federation alignment re-based', async () => {
    await seedStore({ rebased: true });
    const result = emitZoneSpatialZones(ZONE_SET);
    assert.equal(result.models[0].refusal, 'rescaled-by-alignment');
    assert.equal(zoneEntities().length, 0);
  });

  it('refuses IFC2X3, which has no IfcSpatialZone', async () => {
    await seedStore({ schema: 'IFC2X3' });
    const result = emitZoneSpatialZones(ZONE_SET);
    assert.equal(result.models[0].refusal, 'schema-too-old');
    assert.equal(zoneEntities().length, 0);
  });

  it('says so when no element is in any zone', async () => {
    await seedStore();
    useViewerStore.setState({ zoneAssignments: new Map() } as never);
    assert.equal(emitZoneSpatialZones(ZONE_SET).blocked, 'no-members');
  });

  it('refuses a set whose name another set also uses', async () => {
    // Both sets would write LongName 'Takt areas', so the second emission would
    // sweep the first's zones out of the file. The panel asks for a rename
    // rather than picking a winner.
    await seedStore();
    useViewerStore.setState({
      zoneSets: [ZONE_SET, { ...ZONE_SET, id: 'set-2' }],
    } as never);
    assert.equal(emitZoneSpatialZones(ZONE_SET).blocked, 'duplicate-set-name');
    assert.equal(removeZoneSpatialZones(ZONE_SET).blocked, 'duplicate-set-name');
    assert.equal(zoneEntities().length, 0);
  });

  it('refuses a zone with no height, before writing any of the others', async () => {
    await seedStore();
    const flat = { ...ZONE_SET, zones: [ZONE_SET.zones[0], { ...ZONE_SET.zones[1], size: [10, 0, 8] as [number, number, number] }] };
    const result = emitZoneSpatialZones(flat);
    assert.equal(result.models[0].refusal, 'degenerate-zone');
    // The good zone must not be in the file either: the builder emits zone by
    // zone, so a half-written set is the failure this refusal exists to stop.
    assert.equal(zoneEntities().length, 0);
  });

  it('writes nothing at all for a read-only collab role', async () => {
    await seedStore();
    const canEdit = useViewerStore.getState().canCollabEdit;
    useViewerStore.setState({ canCollabEdit: () => false } as never);
    try {
      assert.equal(emitZoneSpatialZones(ZONE_SET).blocked, 'collab-role');
      assert.equal(removeZoneSpatialZones(ZONE_SET).blocked, 'collab-role');
      assert.equal(zoneEntities().length, 0);
    } finally {
      useViewerStore.setState({ canCollabEdit: canEdit } as never);
    }
  });
});
