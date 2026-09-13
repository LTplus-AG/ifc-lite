/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * StatusBar's "N elements" counts OBJECTS — physical elements that have a
 * shape — for the whole model and for a selected storey, and the two halves of
 * "N / M elements" answer the same question (#4655).
 *
 * The storey half used to be `spatialHierarchy.byStorey.get(id).length`: the
 * raw `IfcRelContainedInSpatialStructure` membership, with no schema filter and
 * no geometry filter. On `Building-Structural.ifc` storey #43 that reads 7
 * where the hierarchy trees read 6, because
 *
 *   #162=IFCBUILDINGELEMENTPROXY('1CjP_CWub368bZVuVHeHs3',#1,'Group#21',$,$,#165,$,…);
 *
 * has an ObjectPlacement and `Representation = $` — an authoring-tool group
 * artifact that cannot be seen, isolated, measured or exported.
 *
 * The fixture below reproduces that storey's shape and adds every other case
 * the rule has to separate, so a pass here cannot come from a fixture that
 * happens to contain none of them.
 */

import '@/test/setup-dom.js';
// `__APP_VERSION__` is a vite `define` (see vite.config.ts) baked in at build
// time; under plain Node it doesn't exist, so StatusBar's footer version
// string needs a stand-in before it renders.
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store/index.js';
import { ExtensionHostService } from '@/services/extensions/host.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import { StatusBar } from './StatusBar.js';
import { guid } from './anonymized-export/anonymized-export-fixture.test-support.js';

/**
 * Storey #40 contains six entities:
 *
 * | id  | type                     | shape         | object? | why                           |
 * |-----|--------------------------|---------------|---------|-------------------------------|
 * | #50 | IfcWall                  | own mesh      | yes     | the ordinary case             |
 * | #51 | IfcBuildingElementProxy  | own mesh      | YES     | a proxy is never excluded     |
 * | #52 | IfcBuildingElementProxy  | none          | no      | the #4655 `Representation=$`  |
 * | #53 | IfcAnnotation            | own mesh      | no      | passes shape, fails schema    |
 * | #54 | IfcSpace                 | own mesh      | no      | IfcProduct, not IfcElement    |
 * | #55 | IfcRoof                  | via aggregate | YES     | its mesh lives on the beam    |
 *
 * plus two entities outside the storey: #56 `IfcBeam` (own mesh), aggregated
 * under the roof, and #57 `IfcSlab`, contained in the BUILDING. So: 6 contained
 * rows, 3 objects in the storey, and 4 objects in the whole model (wall,
 * proxy-with-mesh, roof, beam) when #57 has no mesh. #57 exists so a storey
 * total of 0 can be told apart from a whole-model total of 0.
 */
const FIXTURE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('object-count-fixture.ifc','2020-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${guid(1)}',$,'Project',$,$,$,$,$,$);
#2=IFCSITE('${guid(2)}',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#3=IFCBUILDING('${guid(3)}',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#4=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,$,$);
#5=IFCSHAPEREPRESENTATION(#4,'Body','SweptSolid',());
#6=IFCPRODUCTDEFINITIONSHAPE($,$,(#5));
#40=IFCBUILDINGSTOREY('${guid(40)}',$,'00 groundfloor',$,$,$,$,$,.ELEMENT.,0.);
#50=IFCWALL('${guid(50)}',$,'Wall',$,$,$,#6,$,$);
#51=IFCBUILDINGELEMENTPROXY('${guid(51)}',$,'Proxy with geometry',$,$,$,#6,$,$);
#52=IFCBUILDINGELEMENTPROXY('${guid(52)}',$,'Group#21',$,$,$,$,$,$);
#53=IFCANNOTATION('${guid(53)}',$,'Dimension line',$,$,$,#6);
#54=IFCSPACE('${guid(54)}',$,'Living room',$,$,$,#6,$,.ELEMENT.,$,$);
#55=IFCROOF('${guid(55)}',$,'Roof assembly',$,$,$,$,$,$);
#56=IFCBEAM('${guid(56)}',$,'Girder',$,$,$,#6,$,$);
#57=IFCSLAB('${guid(57)}',$,'Slab outside the storey',$,$,$,#6,$,$);
#70=IFCRELAGGREGATES('${guid(70)}',$,$,$,#1,(#2));
#71=IFCRELAGGREGATES('${guid(71)}',$,$,$,#2,(#3));
#72=IFCRELAGGREGATES('${guid(72)}',$,$,$,#3,(#40));
#73=IFCRELAGGREGATES('${guid(73)}',$,$,$,#55,(#56));
#80=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(80)}',$,$,$,(#50,#51,#52,#53,#54,#55),#40);
#81=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(81)}',$,$,$,(#57),#3);
ENDSEC;
END-ISO-10303-21;
`;

const STOREY_ID = 40;
/** Every fixture entity the geometry pipeline produced a mesh for. #52 (no
 *  Representation) and #55 (an assembly) are deliberately absent. */
const MESHED_IDS = [50, 51, 53, 54, 56];

function mesh(expressId: number): MeshData {
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
  };
}

function geometry(expressIds: readonly number[]): GeometryResult {
  return {
    meshes: expressIds.map(mesh),
    totalTriangles: expressIds.length,
    totalVertices: expressIds.length * 3,
  } as GeometryResult;
}

const stubHost = new ExtensionHostService({
  sdk: createBimContext({
    transport: {
      send: () => Promise.reject(new Error('SDK transport is not exercised by this test')),
      subscribe: () => () => {},
      close: () => {},
    },
  }),
});

async function parseFixture(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(FIXTURE);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
function render(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ExtensionHostContext.Provider value={stubHost}>
        <StatusBar />
      </ExtensionHostContext.Provider>,
    );
  });
  mounted.push({ root, container });
  return container;
}
function unmountAll(): void {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
}
after(unmountAll);

let store: IfcDataStore;

beforeEach(async () => {
  unmountAll();
  store = await parseFixture();
  useViewerStore.setState({
    ifcDataStore: store,
    geometryResult: geometry(MESHED_IDS),
    activeModelId: null,
    models: new Map(),
    selectedStoreys: new Set<number>(),
  });
});

/** The rendered "… elements" run, e.g. "3 / 4 elements". */
function elementsText(container: HTMLElement): string {
  const text = container.textContent ?? '';
  const match = /(\d[\d,.\s/]*)elements/.exec(text);
  return match ? `${match[1].trim()} elements` : `<no element count in ${JSON.stringify(text)}>`;
}

describe('StatusBar — "N elements" counts physical elements that have a shape (#4655)', () => {
  it('counts a selected storey by the object rule, not by raw containment', () => {
    useViewerStore.setState({ selectedStoreys: new Set<number>([STOREY_ID]) });
    const container = render();

    // 6 entities are contained in the storey. 3 are objects: the wall, the
    // proxy that HAS a mesh, and the roof whose mesh lives on its aggregated
    // beam. The shapeless proxy, the annotation and the space are not.
    assert.equal(
      elementsText(container),
      '3 / 4 elements',
      'the storey holds 6 contained entities and 3 objects; the model holds 4 objects',
    );
  });

  it('admits a proxy with geometry and rejects one without — never the class, never the name', () => {
    // Give the shapeless proxy a mesh and the count must rise by exactly one:
    // the class and the name ("Group#21") are identical either way, so only
    // the shape can have moved the number.
    useViewerStore.setState({
      selectedStoreys: new Set<number>([STOREY_ID]),
      geometryResult: geometry([...MESHED_IDS, 52]),
    });
    const container = render();
    assert.equal(elementsText(container), '4 / 5 elements');
  });

  it('drops the assembly when its aggregated part loses its mesh', () => {
    setMeshedIds(MESHED_IDS.filter((id) => id !== 56));
    const container = render();
    // Storey: wall + proxy-with-mesh = 2. Model: the same 2 (the roof has no
    // shape anywhere now, and the beam lost its own). The "/ N" fraction is
    // suppressed when the two halves agree, so this renders as one number.
    assert.equal(elementsText(container), '2 elements');
  });

  it('reports the whole-model object total with no storey selected', () => {
    const container = render();
    assert.equal(elementsText(container), '4 elements', 'no "/ N" fraction without a storey selection');
  });

  it('falls back to the schema test alone before any mesh has arrived', () => {
    // Mid-stream: no geometry yet. Applying the shape test here would report a
    // model that plainly has objects as empty.
    useViewerStore.setState({
      selectedStoreys: new Set<number>([STOREY_ID]),
      geometryResult: null,
    });
    const container = render();
    // Storey: wall, both proxies, roof = 4 (annotation and space still fail
    // the schema test). Model: those 4 plus the beam and the slab = 6.
    assert.equal(elementsText(container), '4 / 6 elements');
  });

  it('reports 0 for a storey whose contained entities are all non-objects', () => {
    // Only the annotation and the space have meshes; nothing in the storey is
    // an object. The number must be 0, not a silent fallback to the model
    // total.
    setMeshedIds([53, 54]);
    const container = render();
    assert.equal(
      elementsText(container),
      '0 elements',
      'a resolved storey with no objects must report 0, not fall through to the model total',
    );
  });

  it('reports 0 for an empty storey even when the model elsewhere has objects', () => {
    // The slab sits in the BUILDING, not the storey, and is the only thing
    // with a mesh besides the annotation and the space. A storey count of 0
    // must survive: a falsy-zero fallback would print the model's 1 instead.
    setMeshedIds([53, 54, 57]);
    const container = render();
    assert.equal(elementsText(container), '0 / 1 elements');
  });
});

function setMeshedIds(expressIds: readonly number[]): void {
  useViewerStore.setState({
    selectedStoreys: new Set<number>([STOREY_ID]),
    geometryResult: geometry(expressIds),
  });
}
