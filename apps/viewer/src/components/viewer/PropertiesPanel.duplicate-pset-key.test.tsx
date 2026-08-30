/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An entity can legitimately carry two distinct `IfcPropertySet` (or
 * `IfcElementQuantity`) entities that share the same `Name` -- the same model
 * shape `export-adapter.duplicate-pset-csv.test.ts` and
 * `query-adapter.duplicate-pset-filter.test.ts` fixture, and the same shape
 * `EntityNode.property()`'s own comment documents: "Two distinct
 * IfcPropertySet entities sharing the same Name is a legitimate model shape,
 * and the on-demand extraction path returns one array entry per underlying
 * set rather than merging them."
 *
 * The Properties/Quantities tabs used to key each card by `pset.name` /
 * `qset.name` alone, so two same-named sets collided on one React key. React
 * requires list keys to be unique among siblings and documents duplicate ones
 * as unsupported (children "may be duplicated and/or omitted"); in dev builds
 * it warns via `console.error` ("Encountered two children with the same
 * key"). On the React version in use both cards still rendered their own
 * contents, so the reproduced symptom is the warning, not a dropped card, and
 * the assertions below check both: content present AND no warning. This file
 * mounts the REAL panel over a REAL parsed store (per AGENTS.md: no cast
 * stub) with two same-named sets on one entity.
 */

import '@/test/setup-dom.js';

import { afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { PropertiesPanel } from './PropertiesPanel.js';

const MODEL_ID = 'm1';
const ID_OFFSET = 1_000_000;

function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

const BOILERPLATE = `
#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCBUILDINGSTOREY('${guid('STOR')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#42= IFCBUILDING('${guid('BLDG')}',$,'B',$,$,#40,$,$,.ELEMENT.,$,$,$);
#43= IFCRELAGGREGATES('${guid('AGG1')}',$,$,$,#1,(#42));
#44= IFCRELAGGREGATES('${guid('AGG2')}',$,$,$,#42,(#41));
#45= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RELC')}',$,$,$,(#72),#41);
#72= IFCWALL('${guid('WALA')}',$,'Wall A',$,$,#40,$,'tagA',$);
`;

// Wall #72 carries TWO "Pset_WallCommon" sets (#80/#83, distinct properties)
// and TWO "Qto_WallBaseQuantities" sets (#180/#183, distinct quantities).
const SAME_NAME_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
${BOILERPLATE}
#81= IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#80= IFCPROPERTYSET('${guid('PST1')}',$,'Pset_WallCommon',$,(#81));
#82= IFCRELDEFINESBYPROPERTIES('${guid('RDP1')}',$,$,$,(#72),#80);
#84= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI60'),$);
#83= IFCPROPERTYSET('${guid('PST2')}',$,'Pset_WallCommon',$,(#84));
#85= IFCRELDEFINESBYPROPERTIES('${guid('RDP2')}',$,$,$,(#72),#83);
#181= IFCQUANTITYLENGTH('Width',$,$,200.);
#180= IFCELEMENTQUANTITY('${guid('QTO1')}',$,'Qto_WallBaseQuantities',$,$,(#181));
#182= IFCRELDEFINESBYPROPERTIES('${guid('RDQ1')}',$,$,$,(#72),#180);
#184= IFCQUANTITYLENGTH('Height',$,$,300.);
#183= IFCELEMENTQUANTITY('${guid('QTO2')}',$,'Qto_WallBaseQuantities',$,$,(#184));
#185= IFCRELDEFINESBYPROPERTIES('${guid('RDQ2')}',$,$,$,(#72),#183);
ENDSEC;
END-ISO-10303-21;
`;

// Wall #72 carries TWO unnamed ("") property sets, each with its own property.
const EMPTY_NAME_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
${BOILERPLATE}
#81= IFCPROPERTYSINGLEVALUE('First',$,IFCLABEL('one'),$);
#80= IFCPROPERTYSET('${guid('PST1')}',$,'',$,(#81));
#82= IFCRELDEFINESBYPROPERTIES('${guid('RDP1')}',$,$,$,(#72),#80);
#84= IFCPROPERTYSINGLEVALUE('Second',$,IFCLABEL('two'),$);
#83= IFCPROPERTYSET('${guid('PST2')}',$,'',$,(#84));
#85= IFCRELDEFINESBYPROPERTIES('${guid('RDP2')}',$,$,$,(#72),#83);
ENDSEC;
END-ISO-10303-21;
`;

async function parseModel(step: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(step);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

let initialState: ReturnType<typeof useViewerStore.getState>;

async function seed(step: string, propertiesActiveTab: 'properties' | 'quantities' = 'properties'): Promise<void> {
  const parsed = await parseModel(step);
  useViewerStore.setState({
    models: new Map([[MODEL_ID, {
      id: MODEL_ID,
      name: MODEL_ID,
      ifcDataStore: parsed,
      geometryResult: null,
      visible: true,
      idOffset: ID_OFFSET,
      maxExpressId: 100_000,
      loadedAt: 1,
    }]]) as never,
    activeModelId: MODEL_ID,
    selectedEntity: { modelId: MODEL_ID, expressId: 72 },
    selectedEntityId: 72 + ID_OFFSET,
    selectedEntityIds: new Set<number>(),
    isolatedEntities: null,
    propertiesActiveTab,
  });
}

describe('Properties/Quantities panel -- same-named pset/qset list keys (#3536 follow-up)', () => {
  before(() => {
    initialState = useViewerStore.getState();
  });

  afterEach(() => {
    cleanup();
    useViewerStore.setState(initialState, true);
  });

  it('renders both same-named psets with their own properties and no duplicate-key warning', async () => {
    await seed(SAME_NAME_MODEL);

    const errors: unknown[][] = [];
    const errSpy = mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
    let container: HTMLElement;
    try {
      container = render(<PropertiesPanel />);
    } finally {
      errSpy.mock.restore();
    }

    const text = container.textContent ?? '';
    // Both same-named psets' cards must render -- one with IsExternal, the
    // other with FireRating -- not one dropped/overwritten by the other.
    assert.ok(text.includes('IsExternal'), `IsExternal missing from: ${text}`);
    assert.ok(text.includes('FireRating'), `FireRating missing from: ${text}`);
    assert.equal(container.querySelectorAll('[data-prop-key]').length, 2, 'both property rows must be in the DOM');

    const dupKeyWarning = errors.find((args) =>
      String(args[0]).includes('two children with the same key'));
    assert.equal(dupKeyWarning, undefined, `unexpected duplicate-key warning: ${JSON.stringify(dupKeyWarning)}`);
  });

  it('renders both same-named qsets with their own quantities and no duplicate-key warning', async () => {
    await seed(SAME_NAME_MODEL, 'quantities');

    const errors: unknown[][] = [];
    const errSpy = mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
    let container: HTMLElement;
    try {
      container = render(<PropertiesPanel />);
    } finally {
      errSpy.mock.restore();
    }

    const text = container.textContent ?? '';
    assert.ok(text.includes('Width'), `Width missing from: ${text}`);
    assert.ok(text.includes('Height'), `Height missing from: ${text}`);

    const dupKeyWarning = errors.find((args) =>
      String(args[0]).includes('two children with the same key'));
    assert.equal(dupKeyWarning, undefined, `unexpected duplicate-key warning: ${JSON.stringify(dupKeyWarning)}`);
  });

  it('renders both unnamed ("") psets with their own properties and no duplicate-key warning', async () => {
    await seed(EMPTY_NAME_MODEL);

    const errors: unknown[][] = [];
    const errSpy = mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
    let container: HTMLElement;
    try {
      container = render(<PropertiesPanel />);
    } finally {
      errSpy.mock.restore();
    }

    const text = container.textContent ?? '';
    assert.ok(text.includes('First'), `First missing from: ${text}`);
    assert.ok(text.includes('Second'), `Second missing from: ${text}`);
    assert.equal(container.querySelectorAll('[data-prop-key]').length, 2, 'both property rows must be in the DOM');

    const dupKeyWarning = errors.find((args) =>
      String(args[0]).includes('two children with the same key'));
    assert.equal(dupKeyWarning, undefined, `unexpected duplicate-key warning: ${JSON.stringify(dupKeyWarning)}`);
  });
});
