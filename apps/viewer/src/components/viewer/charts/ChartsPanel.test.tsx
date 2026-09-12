/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Charts panel over a REAL parsed model (#3944): the numbers it renders,
 * what a bucket click does to the 3D selection and visibility channels, and
 * what a 3D pick does to the chart. The chart renderer is a recorder — the
 * option ECharts would draw and the selection pushed into it are asserted,
 * not a canvas.
 */
import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { EChartsOptionObject } from '@ifc-lite/charts';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { render, click, cleanup } from '@/test/render.js';
import { ChartsPanel } from './ChartsPanel.js';
import type { ChartRenderer, ChartRendererEvents } from './useEChart.js';

const MINI_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#2=IFCSITE('0Site000000000000000002',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#3=IFCBUILDING('0Building00000000000003',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#5=IFCBUILDINGSTOREY('0Storey00000000000005',$,'Level 1',$,$,$,$,$,.ELEMENT.,0.);
#6=IFCBUILDINGSTOREY('0Storey00000000000006',$,'Level 2',$,$,$,$,$,.ELEMENT.,3.);
#11=IFCRELAGGREGATES('0Agg000000000000000011',$,$,$,#1,(#2));
#12=IFCRELAGGREGATES('0Agg000000000000000012',$,$,$,#2,(#3));
#13=IFCRELAGGREGATES('0Agg000000000000000013',$,$,$,#3,(#5,#6));
#20=IFCCARTESIANPOINT((0.,0.,0.));
#21=IFCDIRECTION((0.,0.,1.));
#22=IFCDIRECTION((1.,0.,0.));
#23=IFCAXIS2PLACEMENT3D(#20,#21,#22);
#24=IFCLOCALPLACEMENT($,#23);
#25=IFCRECTANGLEPROFILEDEF(.AREA.,$,#23,1.,1.);
#26=IFCEXTRUDEDAREASOLID(#25,#23,#21,1.);
#27=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#26));
#28=IFCPRODUCTDEFINITIONSHAPE($,$,(#27));
#41=IFCWALL('0Wall00000000000000041',$,'Wall A',$,$,#24,#28,$,$);
#42=IFCWALL('0Wall00000000000000042',$,'Wall B',$,$,#24,#28,$,$);
#43=IFCWALL('0Wall00000000000000043',$,'Wall C',$,$,#24,#28,$,$);
#44=IFCDOOR('0Door00000000000000044',$,'Door A',$,$,#24,#28,$,$,$,$,$);
#45=IFCDOOR('0Door00000000000000045',$,'Door B',$,$,#24,#28,$,$,$,$,$);
#90=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Rel000000000000000090',$,$,$,(#41,#42,#44),#5);
#91=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Rel000000000000000091',$,$,$,(#43,#45),#6);
ENDSEC;
END-ISO-10303-21;
`;

const OFFSET = 1_000_000;
const GID = (expressId: number) => OFFSET + expressId;

async function parsedModel(): Promise<FederatedModel> {
  const bytes = new TextEncoder().encode(MINI_IFC);
  const store: IfcDataStore = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return { ...fixtureModel('m1', { idOffset: OFFSET }), name: 'mini.ifc', ifcDataStore: store, maxExpressId: 91 };
}

/** Records every option and selection a card pushes; can fire a chart click. */
interface Recorded { options: EChartsOptionObject[]; selections: number[][]; events: ChartRendererEvents }
function recordingRenderer(): { renderer: ChartRenderer; charts: Recorded[] } {
  const charts: Recorded[] = [];
  const renderer: ChartRenderer = async (_el, events) => {
    const rec: Recorded = { options: [], selections: [], events };
    charts.push(rec);
    return {
      setOption: (option) => { rec.options.push(option); },
      select: (indices) => { rec.selections.push([...indices]); },
      resize: () => {},
      dispose: () => {},
    };
  };
  return { renderer, charts };
}

function barData(option: EChartsOptionObject): Array<[string, number, boolean]> {
  const series = option.series as Array<{ data: Array<{ name: string; value: number; selected: boolean }> }>;
  return series[0].data.map((d) => [d.name, d.value, d.selected]);
}

async function settle(): Promise<void> {
  // The renderer resolves asynchronously; let React commit the ready state and the option effect.
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}

describe('ChartsPanel over a parsed model (#3944)', () => {
  beforeEach(async () => {
    const model = await parsedModel();
    useViewerStore.setState({
      models: new Map([[model.id, model]]),
      activeModelId: model.id,
      dashboards: [],
      activeDashboardId: null,
      chartFocusMode: 'ghost',
      chartColorIn3D: false,
      chartSlice: null,
      chartSliceSource: null,
      chartVisibilityOwned: null,
      selectedEntityIds: new Set(),
      selectedEntityId: null,
      selectedEntitiesSet: new Set(),
      selectedEntities: [],
      isolatedEntities: null,
      ghostExceptEntities: null,
      hiddenEntities: new Set(),
      overlayLayers: new Map(),
      cameraCallbacks: {},
    });
  });
  afterEach(() => cleanup());

  it('seeds the Model overview dashboard and renders the real bucket counts', async () => {
    const { renderer, charts } = recordingRenderer();
    const ui = render(<ChartsPanel renderer={renderer} />);
    await settle();

    const subtitles = [...ui.querySelectorAll('[data-chart-subtitle]')].map((el) => el.textContent);
    assert.equal(subtitles.length, 3);
    assert.match(subtitles[0]!, /2 buckets · 5 elements/);
    // The legend lists the buckets a user can click: walls 3, doors 2.
    const legend = [...ui.querySelectorAll('[data-chart-id] [data-chart-legend] button')].map((b) => b.textContent);
    assert.ok(legend.includes('IfcWall: 3') && legend.includes('IfcDoor: 2'), legend.join(','));
    assert.ok(legend.includes('Level 1: 3') && legend.includes('Level 2: 2'), legend.join(','));
    // What ECharts would draw for the first card.
    assert.deepEqual(barData(charts[0].options.at(-1)!), [['IfcWall', 3, false], ['IfcDoor', 2, false]]);
    assert.equal(useViewerStore.getState().dashboards.length, 1);
  });

  it('a chart click selects the bucket in 3D on both channels, ghosts the rest, claims the channel, and slices the other charts', async () => {
    const { renderer, charts } = recordingRenderer();
    const ui = render(<ChartsPanel renderer={renderer} />);
    await settle();

    // Click the door bucket of the first chart through the chart's own event.
    await act(async () => { charts[0].events.onSelect({ dataIndices: [1] }); });
    await settle();

    const s = useViewerStore.getState();
    assert.deepEqual([...s.selectedEntityIds].sort(), [GID(44), GID(45)]);
    assert.deepEqual([...s.selectedEntitiesSet].sort(), ['m1:44', 'm1:45']);
    assert.deepEqual([...(s.ghostExceptEntities ?? [])].sort(), [GID(44), GID(45)]);
    assert.equal(s.isolatedEntities, null);
    assert.deepEqual(s.chartVisibilityOwned && { channel: s.chartVisibilityOwned.channel, ids: [...s.chartVisibilityOwned.ids].sort() }, { channel: 'ghost', ids: [GID(44), GID(45)] });
    assert.deepEqual([...(s.chartSlice ?? [])].sort(), [GID(44), GID(45)]);

    // The source chart keeps the whole scope but marks the bucket selected;
    // the storey chart re-aggregates over the slice: one door per level.
    assert.deepEqual(barData(charts[0].options.at(-1)!), [['IfcWall', 3, false], ['IfcDoor', 2, true]]);
    const storeySubtitle = ui.querySelectorAll('[data-chart-subtitle]')[1]!.textContent;
    assert.match(storeySubtitle!, /2 buckets · 2 elements/);
    const storeyOption = charts[1].options.at(-1)!;
    assert.deepEqual(barData(storeyOption).map(([n, v]) => [n, v]), [['Level 1', 1], ['Level 2', 1]]);
  });

  it('switching the focus mode re-presents the selection as isolation and releases the ghost claim', async () => {
    const { renderer, charts } = recordingRenderer();
    const ui = render(<ChartsPanel renderer={renderer} />);
    await settle();
    await act(async () => { charts[0].events.onSelect({ dataIndices: [0] }); });
    await settle();
    const focus = ui.querySelector<HTMLSelectElement>('select[aria-label="Focus mode"]')!;
    await act(async () => {
      focus.value = 'isolate';
      focus.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await settle();
    const s = useViewerStore.getState();
    assert.deepEqual([...(s.isolatedEntities ?? [])].sort(), [GID(41), GID(42), GID(43)]);
    assert.equal(s.ghostExceptEntities, null);
    assert.equal(s.chartVisibilityOwned?.channel, 'isolate');
  });

  it('a 3D pick highlights the matching bar and drops the slice; clearing releases only what the panel owns', async () => {
    const { renderer, charts } = recordingRenderer();
    const ui = render(<ChartsPanel renderer={renderer} />);
    await settle();
    await act(async () => { charts[0].events.onSelect({ dataIndices: [1] }); });
    await settle();
    assert.ok(useViewerStore.getState().chartSlice);

    // A pick in the viewport: two of the three walls.
    await act(async () => {
      useViewerStore.setState({ selectedEntityIds: new Set([GID(41), GID(42)]) });
    });
    await settle();
    assert.equal(useViewerStore.getState().chartSlice, null, 'a foreign pick drops the chart slice');
    // Partial bucket: not marked selected in the option, but the chart is told nothing is fully selected.
    assert.deepEqual(barData(charts[0].options.at(-1)!), [['IfcWall', 3, false], ['IfcDoor', 2, false]]);
    assert.deepEqual(charts[0].selections.at(-1), []);

    // Someone else's ghost replaces the panel's: the panel's claim is invalidated by content.
    await act(async () => { useViewerStore.getState().setGhostExceptEntities(new Set([GID(41)])); });
    assert.equal(useViewerStore.getState().chartVisibilityOwned, null);
    click(ui.querySelector('button[title^="Clear the chart selection"]') ?? ui.querySelector('[data-charts-panel]')!);
    // The foreign ghost survives a clear the panel does not own.
    assert.deepEqual([...(useViewerStore.getState().ghostExceptEntities ?? [])], [GID(41)]);
  });

  it('"Colour in 3D" registers an overlay layer with every bucket\'s ids in its colour, and removes it when off', async () => {
    const { renderer } = recordingRenderer();
    const ui = render(<ChartsPanel renderer={renderer} />);
    await settle();
    const toggle = ui.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    click(toggle);
    await settle();
    const layer = useViewerStore.getState().overlayLayers.get('charts');
    assert.ok(layer, 'layer registered');
    assert.equal(layer.priority, 75);
    assert.equal(layer.colorOverrides?.size, 5);
    const wallColor = layer.colorOverrides?.get(GID(41));
    assert.deepEqual(layer.colorOverrides?.get(GID(42)), wallColor);
    assert.notDeepEqual(layer.colorOverrides?.get(GID(44)), wallColor);
    click(toggle);
    await settle();
    assert.equal(useViewerStore.getState().overlayLayers.get('charts'), undefined);
  });

  it('removing the model releases the panel\'s claim and drops the slice', async () => {
    const { renderer, charts } = recordingRenderer();
    render(<ChartsPanel renderer={renderer} />);
    await settle();
    await act(async () => { charts[0].events.onSelect({ dataIndices: [1] }); });
    await settle();
    await act(async () => { useViewerStore.getState().removeModel('m1'); });
    const s = useViewerStore.getState();
    assert.equal(s.chartSlice, null);
    assert.equal(s.chartVisibilityOwned, null);
  });
});
