/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression coverage for #4843: every storey elevation a user READS (the
 * Structure card, the multi-select panel, the hierarchy badges) is absolute,
 * while `spatialHierarchy.storeyElevations` and everything built on it
 * (grouping keys, sort order, matching) stays model-relative.
 *
 * Absolute means height above the map datum when a usable IfcMapConversion
 * exists, and otherwise the storey's world Z through the full PlacementRelTo
 * chain: many exporters keep the real-world offset in the IfcSite placement
 * with no MapConversion at all (the reopened report: storey -5.78 m under a
 * site at Z 125.95 m).
 */

import '@/test/setup-dom.js';

import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PropertiesPanel } from './PropertiesPanel.js';
import { HierarchyPanel } from './HierarchyPanel.js';
import { buildTreeData, buildUnifiedStoreys, elevationKey } from './hierarchy/treeDataBuilder.js';

// The hierarchy list is virtualized and happy-dom reports zero layout, so give
// the scroll container a plausible viewport or no row renders (same stub as
// HierarchyPanel.federation.test.tsx).
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 400 });

const STOREY_ID = 41;
const GROUND_ID = 71;

function source({
  elevation,
  ancestorElevation = 0,
  orthogonalHeight,
  unitPrefix = '$',
  withGeoref = true,
}: {
  elevation: number;
  ancestorElevation?: number;
  orthogonalHeight: number;
  unitPrefix?: '$' | '.MILLI.';
  withGeoref?: boolean;
}): string {
  const pointElevation = unitPrefix === '.MILLI.' ? elevation * 1_000 : elevation;
  const ancestorPointElevation = unitPrefix === '.MILLI.'
    ? ancestorElevation * 1_000
    : ancestorElevation;
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('storey.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'Project',$,$,$,$,(#10),#20);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#20=IFCUNITASSIGNMENT((#21));
#21=IFCSIUNIT(*,.LENGTHUNIT.,${unitPrefix},.METRE.);
#40=IFCLOCALPLACEMENT(#50,#43);
#43=IFCAXIS2PLACEMENT3D(#44,$,$);
#44=IFCCARTESIANPOINT((0.,0.,${pointElevation}.));
#41=IFCBUILDINGSTOREY('0Storey000000000000041',$,'Level',$,$,#40,$,$,.ELEMENT.,$);
#42=IFCBUILDING('0Building000000000042',$,'Building',$,$,#50,$,$,.ELEMENT.,$,$,$);
#45=IFCRELAGGREGATES('0RelProject00000000045',$,$,$,#1,(#42));
#46=IFCRELAGGREGATES('0RelBuilding0000000046',$,$,$,#42,(#41));
#50=IFCLOCALPLACEMENT($,#51);
#51=IFCAXIS2PLACEMENT3D(#52,$,$);
#52=IFCCARTESIANPOINT((0.,0.,${ancestorPointElevation}.));
${withGeoref ? `#30=IFCPROJECTEDCRS('EPSG:2056','Projected','Datum','LN02',$,$,#21);
#31=IFCMAPCONVERSION(#10,#30,2600000.,1200000.,${orthogonalHeight}.,1.,0.,1.);` : ''}
ENDSEC;
END-ISO-10303-21;
`;
}

/**
 * The reopened report's shape: no IfcMapConversion, the real-world offset in
 * the IfcSite placement (rotated about Z, which must not disturb heights), and
 * a Building placed relative to the Site. Storey #41 "Basement" sits at
 * -5.78 m, storey #71 "Ground" at 0 m. Lengths are written in metres or
 * millimetres.
 */
function siteOffsetSource({
  millimetres = false,
  basementElevationAttribute = true,
  siteZ = 125.95,
}: {
  millimetres?: boolean;
  basementElevationAttribute?: boolean;
  siteZ?: number;
} = {}): string {
  const len = (metres: number): string => {
    const text = String(Number((millimetres ? metres * 1_000 : metres).toFixed(6)));
    return text.includes('.') ? text : `${text}.`;
  };
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('site-offset.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'Project',$,$,$,$,(#10),#20);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#20=IFCUNITASSIGNMENT((#21));
#21=IFCSIUNIT(*,.LENGTHUNIT.,${millimetres ? '.MILLI.' : '$'},.METRE.);
#60=IFCSITE('0Site00000000000000060',$,'Site',$,$,#61,$,$,.ELEMENT.,$,$,$,$,$);
#61=IFCLOCALPLACEMENT($,#62);
#62=IFCAXIS2PLACEMENT3D(#63,#64,#65);
#63=IFCCARTESIANPOINT((${len(41266.679)},${len(308208.972)},${len(siteZ)}));
#64=IFCDIRECTION((0.,0.,1.));
#65=IFCDIRECTION((0.8660254,0.5,0.));
#42=IFCBUILDING('0Building000000000042',$,'Building',$,$,#50,$,$,.ELEMENT.,$,$,$);
#50=IFCLOCALPLACEMENT(#61,#51);
#51=IFCAXIS2PLACEMENT3D(#52,$,$);
#52=IFCCARTESIANPOINT((${len(12.5)},${len(-3)},0.));
#41=IFCBUILDINGSTOREY('0Storey000000000000041',$,'Basement',$,$,#40,$,$,.ELEMENT.,${basementElevationAttribute ? len(-5.78) : '$'});
#40=IFCLOCALPLACEMENT(#50,#43);
#43=IFCAXIS2PLACEMENT3D(#44,$,$);
#44=IFCCARTESIANPOINT((0.,0.,${len(-5.78)}));
#71=IFCBUILDINGSTOREY('0Storey000000000000071',$,'Ground',$,$,#70,$,$,.ELEMENT.,0.);
#70=IFCLOCALPLACEMENT(#50,#73);
#73=IFCAXIS2PLACEMENT3D(#74,$,$);
#74=IFCCARTESIANPOINT((0.,0.,0.));
#45=IFCRELAGGREGATES('0RelProject00000000045',$,$,$,#1,(#60));
#46=IFCRELAGGREGATES('0RelSite0000000000046',$,$,$,#60,(#42));
#47=IFCRELAGGREGATES('0RelBuilding0000000047',$,$,$,#42,(#41,#71));
ENDSEC;
END-ISO-10303-21;
`;
}

async function parse(text: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(text);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

function model(
  id: string,
  store: IfcDataStore,
  idOffset: number,
  loadedAt: number,
  rtcZ = 0,
  originShiftY = 125,
): FederatedModel {
  return {
    id,
    name: id,
    ifcDataStore: store,
    geometryResult: {
      meshes: [],
      totalTriangles: 0,
      totalVertices: 0,
      coordinateInfo: {
        originShift: { x: 0, y: originShiftY, z: 0 },
        originalBounds: {
          min: { x: 0, y: 0, z: 0 },
          max: { x: 1, y: 1, z: 1 },
        },
        shiftedBounds: {
          min: { x: 0, y: 0, z: 0 },
          max: { x: 1, y: 1, z: 1 },
        },
        hasLargeCoordinates: rtcZ !== 0,
        wasmRtcOffset: { x: 0, y: 0, z: rtcZ },
      },
    },
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    fileSize: 0,
    idOffset,
    maxExpressId: 80,
    loadedAt,
  };
}

function elevationRow(container: HTMLElement): string {
  // The Structure card row is a label span plus a value span; a storey with a
  // non-null Elevation attribute also lists it under Attributes, differently.
  const row = [...container.querySelectorAll('div')].find(
    (candidate) => candidate.querySelector(':scope > span')?.textContent?.trim() === 'Elevation'
      && candidate.querySelectorAll(':scope > span').length === 2,
  );
  assert.ok(row, `missing Structure/Elevation row in: ${container.textContent}`);
  const cells = row.querySelectorAll(':scope > span');
  assert.equal(cells.length, 2, 'Elevation row shape changed');
  return cells[1].textContent?.trim() ?? '';
}

function selectStorey(modelId: string, idOffset: number, expressId = STOREY_ID): void {
  useViewerStore.setState({
    activeModelId: modelId,
    selectedEntity: { modelId, expressId },
    selectedEntityId: idOffset + expressId,
  });
}

function renderHierarchy(): HTMLElement {
  // A loaded single model also publishes its store as the active one; without
  // it the panel shows its "building the hierarchy" placeholder.
  const { models } = useViewerStore.getState();
  if (models.size === 1) {
    useViewerStore.setState({ ifcDataStore: [...models.values()][0].ifcDataStore });
  }
  return render(
    <SourceHostProvider>
      <TooltipProvider>
        <HierarchyPanel />
      </TooltipProvider>
    </SourceHostProvider>,
  );
}

const BADGE = /^[+-]?\d+\.\d{2}m$/;

/** The elevation badge text of the hierarchy row labelled `label`. */
function hierarchyBadge(container: HTMLElement, label: string): string | undefined {
  const rows = [...container.querySelectorAll<HTMLElement>('.hierarchy-item')];
  const row = rows.find((el) => el.textContent?.includes(label));
  assert.ok(row, `missing hierarchy row "${label}"; rows: ${rows.map((r) => r.textContent).join(' | ')}; panel: ${container.textContent}`);
  return [...row.querySelectorAll('span')]
    .map((span) => span.textContent?.trim() ?? '')
    .find((text) => BADGE.test(text));
}

function hierarchyLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('.hierarchy-item')].map((el) => el.textContent ?? '');
}

let initialState: ReturnType<typeof useViewerStore.getState>;

before(() => {
  initialState = useViewerStore.getState();
});

afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState, true);
});

describe('PropertiesPanel storey elevation with IfcMapConversion (#4843)', () => {
  it('composes ancestor placements before MapConversion but never RTC/origin shifts', async () => {
    // Standard exporter shape: the storey placement is relative to the
    // building placement. The hierarchy intentionally keeps only the 3 m
    // storey-relative fallback; the Inspector must show 500 + 10 + 3.
    const store = await parse(source({
      elevation: 3,
      ancestorElevation: 10,
      orthogonalHeight: 500,
    }));
    const selectedModel = model('metres', store, 1_000_000, 1, 12_345);
    useViewerStore.setState({ models: new Map([['metres', selectedModel]]) });
    selectStorey('metres', 1_000_000);

    assert.equal(store.spatialHierarchy?.storeyElevations.get(STOREY_ID), 3);
    assert.equal(elevationRow(render(<PropertiesPanel />)), '513.00 m');
    assert.equal(
      store.spatialHierarchy?.storeyElevations.get(STOREY_ID),
      3,
      'display conversion must not mutate the relative hierarchy elevation',
    );
    cleanup();
    // The same height reaches the tree badge, with OrthogonalHeight added once.
    assert.equal(hierarchyBadge(renderHierarchy(), 'Level'), '+513.00m');
  });

  it('uses the selected federated model and converts millimetre map heights to metres', async () => {
    const anchorStore = await parse(source({ elevation: 2, orthogonalHeight: 100 }));
    const selectedStore = await parse(source({
      elevation: 3,
      orthogonalHeight: 500_000,
      unitPrefix: '.MILLI.',
    }));
    const anchor = model('anchor', anchorStore, 1_000_000, 1);
    const selected = model('selected', selectedStore, 2_000_000, 2, 999_999);
    useViewerStore.setState({ models: new Map([['anchor', anchor], ['selected', selected]]) });
    selectStorey('selected', 2_000_000);

    assert.equal(selectedStore.spatialHierarchy?.storeyElevations.get(STOREY_ID), 3);
    assert.equal(elevationRow(render(<PropertiesPanel />)), '503.00 m');
  });

  it('composes the placement chain for a model without a projected georeference', async () => {
    // Replaces the #4851 assertion that such a model keeps its relative 3 m:
    // with no MapConversion the absolute height is the chain's world Z, 10 + 3.
    const store = await parse(source({
      elevation: 3,
      ancestorElevation: 10,
      orthogonalHeight: 0,
      withGeoref: false,
    }));
    useViewerStore.setState({ models: new Map([['local', model('local', store, 1_000_000, 1)]]) });
    selectStorey('local', 1_000_000);

    assert.equal(store.spatialHierarchy?.storeyElevations.get(STOREY_ID), 3);
    assert.equal(elevationRow(render(<PropertiesPanel />)), '13.00 m');
  });
});

describe('storey elevation without IfcMapConversion (#4843 reopened)', () => {
  it('shows the site-offset world Z in the Structure card and the tree badge, keeping order relative', async () => {
    const store = await parse(siteOffsetSource());
    useViewerStore.setState({ models: new Map([['site', model('site', store, 1_000_000, 1)]]) });
    selectStorey('site', 1_000_000);

    assert.equal(store.spatialHierarchy?.storeyElevations.get(STOREY_ID), -5.78);
    assert.equal(elevationRow(render(<PropertiesPanel />)), '120.17 m');
    cleanup();

    const tree = renderHierarchy();
    assert.equal(hierarchyBadge(tree, 'Basement'), '+120.17m');
    assert.equal(hierarchyBadge(tree, 'Ground'), '+125.95m');
    const labels = hierarchyLabels(tree);
    const ground = labels.findIndex((text) => text.includes('Ground'));
    const basement = labels.findIndex((text) => text.includes('Basement'));
    assert.ok(ground >= 0 && ground < basement, `default elevation-desc order changed: ${labels.join(' | ')}`);

    assert.deepEqual(
      [...(store.spatialHierarchy?.storeyElevations ?? new Map<number, number>()).entries()]
        .sort((a, b) => a[0] - b[0]),
      [[STOREY_ID, -5.78], [GROUND_ID, 0]],
      'display conversion must not mutate the relative hierarchy elevations',
    );
  });

  it('shows the same world Z in the multi-select panel', async () => {
    const store = await parse(siteOffsetSource());
    useViewerStore.setState({
      models: new Map([['site', model('site', store, 1_000_000, 1)]]),
      selectedEntities: [
        { modelId: 'site', expressId: STOREY_ID },
        { modelId: 'site', expressId: GROUND_ID },
      ],
    });
    selectStorey('site', 1_000_000);

    const text = render(<PropertiesPanel />).textContent ?? '';
    assert.match(text, /\+120\.17m/);
    assert.match(text, /\+125\.95m/);
    assert.doesNotMatch(text, /-5\.78m/);
  });

  it('converts millimetre placements to metres', async () => {
    const store = await parse(siteOffsetSource({ millimetres: true }));
    useViewerStore.setState({ models: new Map([['mm', model('mm', store, 1_000_000, 1)]]) });
    selectStorey('mm', 1_000_000);

    assert.equal(store.spatialHierarchy?.storeyElevations.get(STOREY_ID), -5.78);
    assert.equal(elevationRow(render(<PropertiesPanel />)), '120.17 m');
    cleanup();
    assert.equal(hierarchyBadge(renderHierarchy(), 'Basement'), '+120.17m');
  });

  it('resolves the chain when the storey Elevation attribute is null', async () => {
    const store = await parse(siteOffsetSource({ basementElevationAttribute: false }));
    useViewerStore.setState({ models: new Map([['null', model('null', store, 1_000_000, 1)]]) });
    selectStorey('null', 1_000_000);

    assert.equal(elevationRow(render(<PropertiesPanel />)), '120.17 m');
    cleanup();
    assert.equal(hierarchyBadge(renderHierarchy(), 'Basement'), '+120.17m');
  });

  it('never adds render origin or RTC shifts', async () => {
    const store = await parse(siteOffsetSource());
    const shifted = model('shifted', store, 1_000_000, 1, 308_000, -125);
    useViewerStore.setState({ models: new Map([['shifted', shifted]]) });
    selectStorey('shifted', 1_000_000);

    assert.equal(elevationRow(render(<PropertiesPanel />)), '120.17 m');
    cleanup();
    assert.equal(hierarchyBadge(renderHierarchy(), 'Basement'), '+120.17m');
  });

  it('computes federated badges per model while grouping by relative elevation', async () => {
    const high = await parse(siteOffsetSource());
    const low = await parse(siteOffsetSource({ siteZ: 25.95 }));
    const models = new Map([
      ['high', model('high', high, 1_000_000, 1)],
      ['low', model('low', low, 2_000_000, 2)],
    ]);

    const unified = buildUnifiedStoreys(models);
    assert.deepEqual(
      unified.map((u) => [u.key, u.elevation, u.storeys.length]),
      [[elevationKey(0), 0, 2], [elevationKey(-5.78), -5.78, 2]],
      'federated grouping and order must stay on the relative elevations',
    );
    const basement = unified[1];
    assert.deepEqual(
      basement.storeys.map((storey) => [storey.modelId, Number(storey.displayElevation.toFixed(2))]),
      [['high', 120.17], ['low', 20.17]],
    );

    const unifiedId = `unified-${basement.key}`;
    const nodes = buildTreeData(models, null, new Set([unifiedId]), true, unified);
    const row = nodes.find((node) => node.id === unifiedId);
    assert.ok(row, 'grouped basement row missing');
    assert.equal(row.storeyDisplayElevation, undefined, 'disagreeing models must not borrow one badge');
    assert.deepEqual(
      nodes
        .filter((node) => node.id.startsWith('contrib-'))
        .map((node) => [node.modelIds[0], Number(node.storeyDisplayElevation?.toFixed(2))]),
      [['high', 120.17], ['low', 20.17]],
    );

    // The same file twice: the models agree, so the grouped row carries the badge.
    const twin = await parse(siteOffsetSource());
    useViewerStore.setState({
      models: new Map([
        ['high', model('high', high, 1_000_000, 1)],
        ['twin', model('twin', twin, 2_000_000, 2)],
      ]),
    });
    assert.equal(hierarchyBadge(renderHierarchy(), 'Basement'), '+120.17m');
  });
});
