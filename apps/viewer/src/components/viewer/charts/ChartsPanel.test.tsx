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
import { act, useEffect, useRef, useState } from 'react';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { Clash, ClashResult } from '@ifc-lite/clash';
import type { Renderer } from '@ifc-lite/renderer';
import { aggregate, renderChartSvg, DEFAULT_THEME, type ChartDataset, type ChartItem, type EChartsOptionObject, type ElementFieldBinding, type ReportSpec } from '@ifc-lite/charts';
import { EVENT_FILE_DOWNLOADED } from '@/lib/tours/events.js';
import { captureUiSnapshot, restoreUiSnapshot } from '@/lib/tours/snapshot.js';
import { CLASH_TOUR } from '@/lib/tours/tours/clash.js';
import type { ReportPdfSeams } from '@/lib/export/report/generate-report-pdf.js';
import { chartAwareRendererSelectionFromStore } from '@/lib/charts/renderer-selection.js';
import { useOverlayCompositor } from '@/components/viewer/schedule/useOverlayCompositor.js';
import { useColorOverlaySync } from '@/components/viewer/useColorOverlaySync.js';
import { useIDS, type UseIDSResult } from '@/hooks/useIDS.js';
import { useClash } from '@/hooks/useClash.js';
import { installIdsFocusVisibility } from '@/hooks/ids-focus-visibility.js';
import { useSpaceSceneFraming } from '@/components/viewer/tools/space-sketch/useSpaceSceneFraming.js';
import { modelOverviewDashboard } from '@/lib/charts/presets.js';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { render, click, cleanup } from '@/test/render.js';
import { ChartsPanel, ensureActiveDashboard } from './ChartsPanel.js';
import { EMPTY_HINTS } from './ChartCard.js';
import { chartBucketIdentity, chartColorOverrides, chartSelectionIsLive } from './useChart3DLink.js';
import { selectionFromEChartEvent, type ChartRenderer, type ChartRendererEvents } from './useEChart.js';

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
#100=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('EI60'),$);
#106=IFCPROPERTYSINGLEVALUE('ReferenceLength',$,IFCLENGTHMEASURE(2.),$);
#101=IFCPROPERTYSET('0Pset00000000000000101',$,'Pset_WallCommon',$,(#100,#106));
#102=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000102',$,$,$,(#41,#42),#101);
#103=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('EI30'),$);
#104=IFCPROPERTYSET('0Pset00000000000000104',$,'Pset_WallCommon',$,(#103));
#105=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000105',$,$,$,(#43),#104);
ENDSEC;
END-ISO-10303-21;
`;

const OFFSET = 1_000_000;
const GID = (expressId: number) => OFFSET + expressId;

async function parsedModel(id = 'm1', idOffset = OFFSET, ifc = MINI_IFC): Promise<FederatedModel> {
  const bytes = new TextEncoder().encode(ifc);
  const store: IfcDataStore = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return { ...fixtureModel(id, { idOffset }), name: `${id}.ifc`, ifcDataStore: store, maxExpressId: 106 };
}

/** Records every option and selection a card pushes; can fire a chart click. */
interface Recorded { options: EChartsOptionObject[]; selections: Array<{ full: ChartItem[]; partial: ChartItem[] }>; events: ChartRendererEvents }
function recordingRenderer(): { renderer: ChartRenderer; charts: Recorded[] } {
  const charts: Recorded[] = [];
  const renderer: ChartRenderer = async () => (_el, events) => {
    const rec: Recorded = { options: [], selections: [], events };
    charts.push(rec);
    return {
      setOption: (option) => { rec.options.push(option); },
      select: (full, partial) => { rec.selections.push({ full: [...full], partial: [...partial] }); },
      resize: () => {},
      dispose: () => {},
    };
  };
  return { renderer, charts };
}

function ColorSceneProbe({ applied }: { applied: number[][] }) {
  const pending = useViewerStore((s) => s.pendingColorUpdates);
  const clearPending = useViewerStore((s) => s.clearPendingColorUpdates);
  const rendererRef = useRef<Renderer | null>(null);
  if (!rendererRef.current) {
    let colors: ReadonlyMap<number, readonly number[]> | null = null;
    const scene = {
      setColorOverrides: (next: Map<number, [number, number, number, number]>) => {
        colors = new Map(next);
        applied.push([...next.keys()].sort((a, b) => a - b));
      },
      clearColorOverrides: () => { colors = null; applied.push([]); },
      getColorOverrides: () => colors,
      hasQueuedMeshes: () => false,
      hasMeshData: () => true,
      isInstancedEntity: () => false,
    };
    rendererRef.current = {
      getGPUDevice: () => ({}),
      getPipeline: () => ({}),
      getScene: () => scene,
      requestRender: () => {},
    } as unknown as Renderer;
  }
  useColorOverlaySync({
    rendererRef,
    isInitialized: true,
    pendingColorUpdates: pending,
    clearPendingColorUpdates: clearPending,
  });
  return null;
}

function IDSFocusProbe({ ready }: { ready: (focus: UseIDSResult['focusEntity']) => void }) {
  const { focusEntity } = useIDS();
  useEffect(() => ready(focusEntity), [focusEntity, ready]);
  return null;
}

function ClashFocusProbe({ ready }: { ready: (focus: ReturnType<typeof useClash>['focusClash']) => void }) {
  const { focusClash } = useClash();
  useEffect(() => ready(focusClash), [focusClash, ready]);
  return null;
}

function ClosableChartsProbe({ renderer, ready }: { renderer: ChartRenderer; ready: (close: () => void) => void }) {
  const [open, setOpen] = useState(true);
  useEffect(() => ready(() => setOpen(false)), [ready]);
  return open ? <ChartsPanel renderer={renderer} /> : null;
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
      chartSliceBuckets: null,
      chartSelectionRevision: null,
      selectionRevision: 0,
      chartVisibilityOwned: null,
      chartVisibilityRevision: null,
      clashResult: null,
      clashGroups: null,
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

  it('authors a property chart through the visible editor and keeps real member ids (#4833)', async () => {
    const { renderer, charts } = recordingRenderer();
    const ui = render(<ChartsPanel renderer={renderer} />);
    await settle();
    click([...ui.querySelectorAll('button')].find((button) => button.textContent?.includes('Add chart'))!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await settle();

    const source = ui.querySelector<HTMLSelectElement>('select[aria-label="Element field source"]')!;
    assert.ok(source, 'the Elements source exposes an IFC field selector');
    await act(async () => {
      source.value = 'property';
      source.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await settle();
    assert.equal(ui.querySelector<HTMLSelectElement>('select[aria-label="IFC property set"]')!.value, 'Pset_WallCommon');
    assert.match(ui.querySelector<HTMLSelectElement>('select[aria-label="IFC property"]')!.textContent!, /FireRating/);

    click([...ui.querySelectorAll('button')].find((button) => button.textContent === 'Save chart')!);
    await settle();
    const added = charts.at(-1)!;
    assert.deepEqual(barData(added.options.at(-1)!).map(([name, count]) => [name, count]), [['EI60', 2], ['EI30', 1]]);
    await act(async () => { added.events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 0 }] }); });
    await settle();
    assert.deepEqual([...useViewerStore.getState().selectedEntityIds].sort(), [GID(41), GID(42)]);
  });

  it('enables IFC field discovery when an existing non-element chart switches to Elements (#4833)', async () => {
    const dashboard = modelOverviewDashboard();
    dashboard.charts = [{ ...dashboard.charts[0], title: 'Clash chart', source: 'clash', dimension: 'Severity' }];
    dashboard.layout = dashboard.layout.slice(0, 1);
    useViewerStore.setState({ dashboards: [dashboard], activeDashboardId: dashboard.id });
    const { renderer } = recordingRenderer();
    const ui = render(<ChartsPanel renderer={renderer} />);
    await settle();
    click(ui.querySelector<HTMLButtonElement>('button[aria-label="Edit Clash chart"]')!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const chartSource = ui.querySelector<HTMLSelectElement>('select[aria-label="Source"]')!;
    await act(async () => {
      chartSource.value = 'elements';
      chartSource.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await settle();
    const fieldSource = ui.querySelector<HTMLSelectElement>('select[aria-label="Element field source"]')!;
    assert.equal([...fieldSource.options].find(({ value }) => value === 'attribute')?.disabled, false);
    assert.equal([...fieldSource.options].find(({ value }) => value === 'property')?.disabled, false);
  });

  it('invalidates a selected bucket when a mutation changes its membership (#4833)', () => {
    const spec = { id: 'field', title: 'Rating', source: 'elements' as const, type: 'bar' as const, dimension: 'Rating', measure: { agg: 'count' as const } };
    const dataset = (ratings: readonly string[]): ChartDataset => ({
      source: 'elements',
      fingerprint: ratings.join(','),
      columns: [{ id: 'Rating', label: 'Rating', kind: 'category' }],
      rows: ratings.map((rating, index) => ({ ids: [index + 1], values: [rating] })),
    });
    const selected = aggregate(spec, dataset(['A', 'A', 'B']));
    const identity = chartBucketIdentity(selected, { seriesIndex: 0, dataIndex: 0 });
    assert.ok(identity);
    const changed = aggregate(spec, dataset(['B', 'A', 'B']));
    assert.equal(chartSelectionIsLive(changed, [identity], new Set([1, 2])), false);

    const filtered = aggregate(spec, dataset(['A', 'A', 'B']), { slice: new Set([1]) });
    const filteredIdentity = chartBucketIdentity(filtered, { seriesIndex: 0, dataIndex: 0 });
    assert.ok(filteredIdentity);
    assert.equal(chartSelectionIsLive(selected, [filteredIdentity], new Set([1])), true, 'removing another chart filter must not clear the click');

    const otherSpec = { ...spec, topN: 1 };
    const folded = aggregate(otherSpec, dataset(['A', 'A', 'A', 'B', 'C']));
    const otherIdentity = chartBucketIdentity(folded, { seriesIndex: 0, dataIndex: 1 });
    assert.ok(otherIdentity);
    const unfolded = aggregate({ ...otherSpec, topN: 3 }, dataset(['A', 'A', 'A', 'B', 'C']));
    assert.equal(chartSelectionIsLive(unfolded, [otherIdentity], new Set([4, 5])), true);
    const expanded = aggregate(otherSpec, dataset(['A', 'A', 'A', 'B', 'C', 'C']));
    assert.equal(chartSelectionIsLive(expanded, [otherIdentity], new Set([4, 5])), false);
  });

  it('resets an incompatible histogram and sum when its IFC field becomes categorical (#4833)', async () => {
    const numeric: ElementFieldBinding = {
      kind: 'property', psetName: 'Pset_WallCommon', propertyName: 'ReferenceLength', valueKind: 'number', dataType: 'IFCLENGTHMEASURE',
    };
    const categorical: ElementFieldBinding = {
      kind: 'property', psetName: 'Pset_WallCommon', propertyName: 'FireRating', valueKind: 'category', dataType: 'IFCLABEL',
    };
    const { renderer } = recordingRenderer();
    const ui = render(<ChartsPanel renderer={renderer} />);
    await settle();
    click([...ui.querySelectorAll('button')].find((button) => button.textContent?.includes('Add chart'))!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await settle();

    const source = ui.querySelector<HTMLSelectElement>('select[aria-label="Element field source"]')!;
    await act(async () => {
      source.value = 'property';
      source.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    let property = ui.querySelector<HTMLSelectElement>('select[aria-label="IFC property"]')!;
    const numericId = [...property.options].find((option) => option.textContent === numeric.propertyName)!.value;
    await act(async () => {
      property.value = numericId;
      property.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    assert.equal(ui.querySelector<HTMLSelectElement>('select[aria-label="Chart type"]')!.value, 'histogram');
    const measure = ui.querySelector<HTMLSelectElement>('select[aria-label="Measure"]')!;
    await act(async () => {
      measure.value = `sum:${numericId}`;
      measure.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    assert.match(measure.value, /^sum:/);

    property = ui.querySelector<HTMLSelectElement>('select[aria-label="IFC property"]')!;
    const categoryId = [...property.options].find((option) => option.textContent === categorical.propertyName)!.value;
    await act(async () => {
      property.value = categoryId;
      property.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    assert.equal(ui.querySelector<HTMLSelectElement>('select[aria-label="Chart type"]')!.value, 'bar');
    assert.equal(ui.querySelector<HTMLSelectElement>('select[aria-label="Measure"]')!.value, 'count');
    click([...ui.querySelectorAll('button')].find((button) => button.textContent === 'Save chart')!);
    const saved = useViewerStore.getState().dashboards[0].charts.at(-1)!;
    assert.deepEqual(saved.measure, { agg: 'count' });
    assert.equal(saved.dimension, categoryId);
  });

  it('a mount undone while the engine is still loading creates no chart, and the seed is idempotent — what StrictMode does in dev (browser finding)', async () => {
    const live: string[] = [];
    // The engine resolves only after React has mounted, unmounted and mounted again.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const renderer: ChartRenderer = async () => {
      await gate;
      return (el) => {
        live.push(el.tagName);
        return { setOption: () => {}, select: () => {}, resize: () => {}, dispose: () => { live.pop(); } };
      };
    };
    render(<ChartsPanel renderer={renderer} />);
    cleanup();
    const ui = render(<ChartsPanel renderer={renderer} />);
    release();
    await settle();
    assert.equal(ui.querySelectorAll('[data-chart-host]').length, 3);
    assert.equal(live.length, 3, 'one live chart per card; the undone first mount created none');

    // The seed effect runs twice on the same empty snapshot under StrictMode.
    ensureActiveDashboard();
    ensureActiveDashboard();
    assert.equal(useViewerStore.getState().dashboards.length, 1, 'the double effect must not seed twice');
  });

  it('a chart click selects the bucket in 3D on both channels, ghosts the rest, claims the channel, and slices the other charts', async () => {
    const { renderer, charts } = recordingRenderer();
    const ui = render(<ChartsPanel renderer={renderer} />);
    await settle();

    // Click the door bucket of the first chart through the chart's own event.
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();

    const s = useViewerStore.getState();
    assert.deepEqual([...s.selectedEntityIds].sort(), [GID(44), GID(45)]);
    assert.deepEqual([...s.selectedEntitiesSet].sort(), ['m1:44', 'm1:45']);
    assert.deepEqual([...(s.ghostExceptEntities ?? [])].sort(), [GID(44), GID(45)]);
    assert.equal(s.isolatedEntities, null);
    assert.deepEqual(s.chartVisibilityOwned && { channel: s.chartVisibilityOwned.channel, ids: [...s.chartVisibilityOwned.ids].sort() }, { channel: 'ghost', ids: [GID(44), GID(45)] });
    assert.deepEqual([...(s.chartSlice ?? [])].sort(), [GID(44), GID(45)]);
    assert.deepEqual(s.chartSliceBuckets?.map(({ color: _color, ids: _ids, dataFingerprint: _fingerprint, ...identity }) => identity), [{ seriesKey: 'IfcType', bucketKey: 'IfcDoor', isOther: false }]);

    // The source chart keeps the whole scope but marks the bucket selected;
    // the storey chart re-aggregates over the slice: one door per level.
    assert.deepEqual(barData(charts[0].options.at(-1)!), [['IfcWall', 3, false], ['IfcDoor', 2, true]]);
    const storeySubtitle = ui.querySelectorAll('[data-chart-subtitle]')[1]!.textContent;
    assert.match(storeySubtitle!, /2 buckets · 2 elements/);
    const storeyOption = charts[1].options.at(-1)!;
    assert.deepEqual(barData(storeyOption).map(([n, v]) => [n, v]), [['Level 1', 1], ['Level 2', 1]]);

    // A later click replaces — never unions with — the first bucket.
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 0 }] }); });
    await settle();
    const replaced = useViewerStore.getState();
    assert.deepEqual([...replaced.selectedEntityIds].sort(), [GID(41), GID(42), GID(43)]);
    assert.deepEqual([...replaced.selectedEntitiesSet].sort(), ['m1:41', 'm1:42', 'm1:43']);
    assert.deepEqual([...(replaced.ghostExceptEntities ?? [])].sort(), [GID(41), GID(42), GID(43)]);
  });

  it('switching the focus mode re-presents the selection as isolation and releases the ghost claim', async () => {
    const { renderer, charts } = recordingRenderer();
    const ui = render(<ChartsPanel renderer={renderer} />);
    await settle();
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 0 }] }); });
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

  it('re-presents after Space Sketch captures and restores the chart-owned ghost (#4832)', async () => {
    const { renderer, charts } = recordingRenderer();
    function MountedSpaceChart() {
      const [spaceOpen, setSpaceOpen] = useState(false);
      useSpaceSceneFraming({ enabled: spaceOpen, existingSpaceIds: [] });
      return <>
        <button type="button" onClick={() => setSpaceOpen((open) => !open)}>Space</button>
        <ChartsPanel renderer={renderer} />
      </>;
    }
    const ui = render(<MountedSpaceChart />);
    await settle();
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 0 }] }); });
    await settle();

    const space = ui.querySelector('button')!;
    click(space);
    click(space);
    await settle();
    const replayed = useViewerStore.getState();
    assert.equal(replayed.chartVisibilityOwned?.channel, 'ghost');
    assert.notEqual(
      replayed.chartVisibilityRevision,
      replayed.visibilityRevision,
      'the real Space Sketch restore is a content-preserving foreign replay',
    );

    const focus = ui.querySelector<HTMLSelectElement>('select[aria-label="Focus mode"]')!;
    await act(async () => {
      focus.value = 'isolate';
      focus.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await settle();
    const state = useViewerStore.getState();
    assert.deepEqual([...(state.isolatedEntities ?? [])].sort(), [GID(41), GID(42), GID(43)]);
    assert.equal(state.ghostExceptEntities, null);
    assert.equal(state.chartVisibilityOwned?.channel, 'isolate');
  });

  it('a 3D pick highlights the matching bar and drops the slice; clearing releases only what the panel owns', async () => {
    const { renderer, charts } = recordingRenderer();
    const ui = render(<ChartsPanel renderer={renderer} />);
    await settle();
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    assert.ok(useViewerStore.getState().chartSlice);

    // A pick in the viewport: two of the three walls.
    await act(async () => {
      useViewerStore.getState().setSelectedEntityIds([GID(41), GID(42)]);
    });
    await settle();
    assert.equal(useViewerStore.getState().chartSlice, null, 'a foreign pick drops the chart slice');
    // Partial bucket: not marked selected in the option, but pushed to the chart as an emphasised item.
    assert.deepEqual(barData(charts[0].options.at(-1)!), [['IfcWall', 3, false], ['IfcDoor', 2, false]]);
    assert.deepEqual(charts[0].selections.at(-1), { full: [], partial: [{ seriesIndex: 0, dataIndex: 0 }] });

    // Someone else's ghost replaces the panel's: the panel's claim is invalidated by content.
    await act(async () => { useViewerStore.getState().setGhostExceptEntities(new Set([GID(41)])); });
    assert.equal(useViewerStore.getState().chartVisibilityOwned, null);
    click(ui.querySelector('button[title^="Clear the chart selection"]') ?? ui.querySelector('[data-charts-panel]')!);
    // The foreign ghost survives a clear the panel does not own.
    assert.deepEqual([...(useViewerStore.getState().ghostExceptEntities ?? [])], [GID(41)]);
  });

  it('"Colour in 3D" registers an overlay layer with every bucket\'s ids in its colour, and removes it when off', async () => {
    const { renderer, charts } = recordingRenderer();
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

    // Under ghost focus only the clicked bucket keeps the chart paint. Context
    // retains authored colours and receives translucency from ghostExcept.
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    const selectedLayer = useViewerStore.getState().overlayLayers.get('charts');
    assert.deepEqual([...(selectedLayer?.colorOverrides?.keys() ?? [])].sort(), [GID(44), GID(45)]);
    assert.deepEqual([...(useViewerStore.getState().ghostExceptEntities ?? [])].sort(), [GID(44), GID(45)]);
    click(toggle);
    await settle();
    assert.equal(useViewerStore.getState().overlayLayers.get('charts'), undefined);
  });

  it('resolves one replacement bucket through both models in a federation', async () => {
    const secondOffset = 2_000_000;
    const second = await parsedModel('m2', secondOffset);
    useViewerStore.setState((state) => ({
      models: new Map([...state.models, [second.id, second]]),
    }));
    const { renderer, charts } = recordingRenderer();
    render(<ChartsPanel renderer={renderer} />);
    await settle();

    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    const state = useViewerStore.getState();
    assert.deepEqual([...state.selectedEntityIds].sort(), [GID(44), GID(45), secondOffset + 44, secondOffset + 45]);
    assert.deepEqual([...state.selectedEntitiesSet].sort(), ['m1:44', 'm1:45', 'm2:44', 'm2:45']);
    await act(async () => { useViewerStore.getState().removeModel('m1'); });
    await settle();
    cleanup();
    assert.equal(useViewerStore.getState().chartVisibilityOwned, null);
    assert.equal(useViewerStore.getState().ghostExceptEntities, null, 'federation teardown cannot strand surviving ghost IDs after Charts closes');
  });

  it('keeps chart presentation when an unrelated federated model is removed (#4832)', async () => {
    const unrelated = fixtureModel('m2', { idOffset: 2_000_000 });
    useViewerStore.setState((state) => ({ models: new Map([...state.models, [unrelated.id, unrelated]]) }));
    const { renderer, charts } = recordingRenderer();
    render(<ChartsPanel renderer={renderer} />);
    await settle();

    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    const before = useViewerStore.getState();
    assert.deepEqual([...(before.chartSlice ?? [])].sort(), [GID(44), GID(45)]);
    assert.deepEqual([...(before.ghostExceptEntities ?? [])].sort(), [GID(44), GID(45)]);

    await act(async () => { useViewerStore.getState().removeModel('m2'); });
    await settle();
    const after = useViewerStore.getState();
    assert.deepEqual([...(after.chartSlice ?? [])].sort(), [GID(44), GID(45)]);
    assert.deepEqual([...(after.ghostExceptEntities ?? [])].sort(), [GID(44), GID(45)]);
    assert.equal(after.chartVisibilityOwned?.channel, 'ghost');
  });

  it('uses the clicked chart bucket colour rather than the headline chart colour', async () => {
    const { renderer, charts } = recordingRenderer();
    const ui = render(<ChartsPanel renderer={renderer} />);
    await settle();
    click(ui.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await settle();

    // Level 1 in the second chart contains walls A/B and door A. Its three ids
    // must share that storey bucket's colour, not the type colours from chart 1.
    await act(async () => { charts[1].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 0 }] }); });
    await settle();
    const colors = useViewerStore.getState().overlayLayers.get('charts')?.colorOverrides;
    assert.deepEqual([...(colors?.keys() ?? [])].sort(), [GID(41), GID(42), GID(44)]);
    assert.deepEqual(colors?.get(GID(41)), colors?.get(GID(44)));
  });

  it('removes stale chart paint when every dashboard chart is deleted (#4832)', async () => {
    const { renderer, charts } = recordingRenderer();
    const ui = render(<ChartsPanel renderer={renderer} />);
    await settle();
    click(ui.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await settle();
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    const selected = useViewerStore.getState().selectedEntityIds;
    const oldPaint = useViewerStore.getState().overlayLayers.get('charts')?.colorOverrides ?? null;
    assert.ok(oldPaint?.size);

    const active = useViewerStore.getState().dashboards.find((d) => d.id === useViewerStore.getState().activeDashboardId)!;
    await act(async () => { useViewerStore.getState().upsertDashboard({ ...active, charts: [], layout: [] }); });
    await settle();
    assert.equal(useViewerStore.getState().overlayLayers.has('charts'), false);
    const restored = chartAwareRendererSelectionFromStore(null, selected, oldPaint);
    assert.equal(restored.selectedIds, selected, 'deleted charts cannot suppress selection through a cached aggregation');
  });

  it('releases chart-owned selection and presentation when its source card is deleted (#4832)', async () => {
    const { renderer, charts } = recordingRenderer();
    render(<ChartsPanel renderer={renderer} />);
    await settle();
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    const selectedSource = useViewerStore.getState().chartSliceSource;
    assert.ok(selectedSource);
    assert.ok(useViewerStore.getState().ghostExceptEntities?.size);

    const active = useViewerStore.getState().dashboards.find((d) => d.id === useViewerStore.getState().activeDashboardId)!;
    await act(async () => {
      useViewerStore.getState().setSelectedEntityIds([GID(41)]);
      useViewerStore.getState().setSelectedEntityId(GID(41));
      useViewerStore.getState().upsertDashboard({
        ...active,
        charts: active.charts.filter(({ id }) => id !== selectedSource),
        layout: active.layout.filter(({ chartId }) => chartId !== selectedSource),
      });
    });
    await settle();
    const state = useViewerStore.getState();
    assert.ok(state.dashboards[0].charts.length > 0, 'the panel and another chart remain mounted');
    assert.equal(state.chartSlice, null);
    assert.equal(state.chartSliceSource, null);
    assert.equal(state.chartSliceBuckets, null);
    assert.deepEqual([...state.selectedEntityIds], [GID(41)], 'source deletion cannot erase a newer independent pick');
    assert.equal(state.ghostExceptEntities, null);
    assert.equal(state.chartVisibilityOwned, null);
  });

  it('preserves a newer primary-only IDS focus when its source card is deleted (#4832)', async () => {
    const { renderer, charts } = recordingRenderer();
    let focusEntity: UseIDSResult['focusEntity'] | null = null;
    const ready = (focus: UseIDSResult['focusEntity']): void => { focusEntity = focus; };
    render(<><IDSFocusProbe ready={ready} /><ChartsPanel renderer={renderer} /></>);
    await settle();
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    const selectedSource = useViewerStore.getState().chartSliceSource;
    const active = useViewerStore.getState().dashboards.find((d) => d.id === useViewerStore.getState().activeDashboardId)!;
    assert.ok(selectedSource);
    assert.ok(focusEntity);

    await act(async () => {
      focusEntity!('m1', 41, 'highlight', false);
      useViewerStore.getState().upsertDashboard({
        ...active,
        charts: active.charts.filter(({ id }) => id !== selectedSource),
        layout: active.layout.filter(({ chartId }) => chartId !== selectedSource),
      });
    });
    await settle();

    const state = useViewerStore.getState();
    assert.equal(state.selectedEntityId, 41, 'stale chart cleanup cannot erase the newer IDS primary');
    assert.deepEqual([...state.selectedEntityIds].sort(), [GID(44), GID(45)], 'primary-only focus leaves the existing set intact');
    assert.equal(state.chartSlice, null);
    assert.equal(state.chartVisibilityOwned, null);
    assert.equal(state.ghostExceptEntities, null);
  });

  it('preserves newer same-ID IDS ghost and isolate ownership during chart cleanup (#4832)', async () => {
    const { renderer, charts } = recordingRenderer();
    let focusEntity: UseIDSResult['focusEntity'] | null = null;
    let closeCharts: (() => void) | null = null;
    const ready = (focus: UseIDSResult['focusEntity']): void => { focusEntity = focus; };
    const readyToClose = (close: () => void): void => { closeCharts = close; };
    render(<><IDSFocusProbe ready={ready} /><ClosableChartsProbe renderer={renderer} ready={readyToClose} /></>);
    await settle();
    assert.ok(focusEntity && closeCharts);

    for (const mode of ['ghost', 'isolate'] as const) {
      const chart = charts.at(-1)!;
      const stacked = chart.options.at(-1)!.series as Array<{ name: string; data: Array<{ name: string }> }>;
      const doorSeries = stacked.findIndex(({ name }) => name === 'IfcDoor');
      const level1 = stacked[doorSeries].data.findIndex(({ name }) => name === 'Level 1');
      assert.ok(doorSeries >= 0 && level1 >= 0);

      await act(async () => { chart.events.onSelect({ items: [{ seriesIndex: doorSeries, dataIndex: level1 }] }); });
      assert.deepEqual([...useViewerStore.getState().selectedEntityIds], [GID(44)]);
      assert.equal(useViewerStore.getState().chartVisibilityOwned?.channel, 'ghost');

      await act(async () => {
        installIdsFocusVisibility(mode, new Set([GID(44)]));
        assert.equal(
          useViewerStore.getState().chartVisibilityOwned,
          null,
          'the IDS visibility installer must atomically supersede equal-content chart ownership',
        );
        focusEntity!('m1', 44, mode, false);
        assert.equal(
          useViewerStore.getState().chartVisibilityOwned,
          null,
          'the IDS write must atomically supersede equal-content chart ownership',
        );
        closeCharts!();
      });
      await settle();
      const state = useViewerStore.getState();
      const expected = state.selectedEntityId === 44 ? 44 : GID(44);
      assert.equal(state.chartVisibilityOwned, null, 'the atomic IDS claim supersedes the equal-ID chart claim');
      assert.equal(state.idsFocusVisibilityOwned?.channel, mode);
      assert.deepEqual(
        [...(mode === 'ghost' ? state.ghostExceptEntities ?? [] : state.isolatedEntities ?? [])],
        [expected],
        `chart cleanup must preserve IDS ${mode}`,
      );

      if (mode === 'ghost') {
        useViewerStore.getState().clearEntitySelection();
        useViewerStore.getState().setChartSlice(null);
        cleanup();
        focusEntity = null;
        closeCharts = null;
        render(<><IDSFocusProbe ready={ready} /><ClosableChartsProbe renderer={renderer} ready={readyToClose} /></>);
        await settle();
        assert.ok(focusEntity && closeCharts);
      }
    }
  });

  it('hands equal-ID isolation to the basket before chart cleanup runs (#4832)', async () => {
    const { renderer, charts } = recordingRenderer();
    render(<ChartsPanel renderer={renderer} />);
    await settle();
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    assert.equal(useViewerStore.getState().chartVisibilityOwned?.channel, 'ghost');

    await act(async () => {
      useViewerStore.getState().setBasket([
        { modelId: 'm1', expressId: 44 },
        { modelId: 'm1', expressId: 45 },
      ]);
    });
    await settle();
    const state = useViewerStore.getState();
    assert.equal(state.chartSlice, null);
    assert.equal(state.chartVisibilityOwned, null);
    assert.equal(state.basketVisibilityOwned?.channel, 'isolate');
    assert.equal(state.ghostExceptEntities, null);
    assert.deepEqual([...(state.isolatedEntities ?? [])].sort(), [GID(44), GID(45)]);

    cleanup();
    assert.deepEqual(
      [...(useViewerStore.getState().isolatedEntities ?? [])].sort(),
      [GID(44), GID(45)],
      'unmount cleanup cannot release the newer equal-ID basket isolation',
    );
  });

  it('preserves a newer equal-ID clash ghost when chart cleanup runs (#4832)', async () => {
    const { renderer, charts } = recordingRenderer();
    let focusClash: ReturnType<typeof useClash>['focusClash'] | null = null;
    const ready = (focus: ReturnType<typeof useClash>['focusClash']): void => { focusClash = focus; };
    render(<><ClashFocusProbe ready={ready} /><ChartsPanel renderer={renderer} /></>);
    await settle();
    assert.ok(focusClash);

    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    assert.deepEqual([...(useViewerStore.getState().ghostExceptEntities ?? [])].sort(), [GID(44), GID(45)]);

    const clash: Clash = {
      id: 'equal-door-pair',
      a: { key: 'door-a', ref: GID(44), model: 'm1', tag: 'IfcDoor' },
      b: { key: 'door-b', ref: GID(45), model: 'm1', tag: 'IfcDoor' },
      rule: 'Doors', status: 'hard', distance: -0.05, point: [0, 0, 0],
      bounds: { min: [0, 0, 0], max: [1, 1, 1] }, severity: 'major',
    };
    await act(async () => { focusClash!(clash, 'ghost'); });
    await settle();

    const state = useViewerStore.getState();
    assert.equal(state.chartSlice, null);
    assert.equal(state.chartVisibilityOwned, null);
    assert.equal(state.clashVisibilityOwned?.channel, 'ghost');
    assert.deepEqual([...(state.ghostExceptEntities ?? [])].sort(), [GID(44), GID(45)]);
  });

  it('does not revive a chart ghost over visibility changed while Charts was closed (#4832)', async () => {
    const { renderer, charts } = recordingRenderer();
    render(<ChartsPanel renderer={renderer} />);
    await settle();
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    cleanup();
    assert.equal(useViewerStore.getState().ghostExceptEntities, null);
    assert.ok(useViewerStore.getState().chartSlice, 'closing Charts retains logical selection');

    installIdsFocusVisibility('isolate', new Set([GID(41)]));
    render(<ChartsPanel renderer={renderer} />);
    await settle();

    const state = useViewerStore.getState();
    assert.equal(state.ghostExceptEntities, null);
    assert.deepEqual([...(state.isolatedEntities ?? [])], [GID(41)]);
    assert.equal(state.idsFocusVisibilityOwned?.channel, 'isolate');
    assert.equal(state.chartVisibilityOwned, null);
  });

  it('reconciles same-ID independent selection after Charts closes and reopens (#4832)', async () => {
    const { renderer, charts } = recordingRenderer();
    render(<ChartsPanel renderer={renderer} />);
    await settle();
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    const doorIds = [...useViewerStore.getState().selectedEntityIds];
    assert.deepEqual(doorIds.sort(), [GID(44), GID(45)]);

    cleanup();
    const reopened = render(<ChartsPanel renderer={renderer} />);
    await settle();
    await act(async () => {
      // A genuinely new ordinary selection may contain the exact same IDs.
      useViewerStore.getState().setSelectedEntityIds(doorIds);
      useViewerStore.getState().setSelectedEntityId(GID(45));
    });
    await settle();

    const state = useViewerStore.getState();
    assert.equal(state.chartSlice, null, 'store provenance, not a mount-local ref, releases the stale chart slice');
    assert.equal(state.chartSliceSource, null);
    assert.deepEqual([...state.selectedEntityIds].sort(), [GID(44), GID(45)]);
    assert.equal(state.selectedEntityId, GID(45));
    assert.equal(state.chartVisibilityOwned, null);
    assert.equal(state.ghostExceptEntities, null);
    const subtitles = [...reopened.querySelectorAll('[data-chart-subtitle]')].map((el) => el.textContent);
    assert.ok(subtitles.every((text) => /5 elements$/.test(text ?? '')), subtitles.join(' | '));
  });

  it('does not reclaim an independently replaced same-ID selection after partial federation teardown (#4832)', async () => {
    const secondOffset = 2_000_000;
    const second = await parsedModel('m2', secondOffset);
    useViewerStore.setState((state) => ({ models: new Map([...state.models, [second.id, second]]) }));
    const { renderer, charts } = recordingRenderer();
    render(<ChartsPanel renderer={renderer} />);
    await settle();
    const sourceId = useViewerStore.getState().dashboards[0].charts[0].id;

    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    const sameIds = [...useViewerStore.getState().selectedEntityIds];
    cleanup();
    useViewerStore.getState().setSelectedEntityIds(sameIds);
    useViewerStore.getState().setSelectedEntityId(secondOffset + 45);

    await act(async () => { useViewerStore.getState().removeModel('m1'); });
    const afterRemoval = useViewerStore.getState();
    assert.notEqual(afterRemoval.chartSelectionRevision, afterRemoval.selectionRevision);

    render(<ChartsPanel renderer={renderer} />);
    await settle();
    const dashboard = useViewerStore.getState().dashboards[0];
    useViewerStore.getState().setDashboards([{ ...dashboard, charts: dashboard.charts.filter(({ id }) => id !== sourceId) }]);
    await settle();
    const final = useViewerStore.getState();
    assert.equal(final.chartSlice, null);
    assert.deepEqual([...final.selectedEntityIds].sort(), [secondOffset + 44, secondOffset + 45]);
    assert.equal(final.selectedEntityId, secondOffset + 45);
  });

  it('keeps model-A chart ownership when only model-B storey state is removed (#4832)', async () => {
    const secondOffset = 2_000_000;
    const unrelated = fixtureModel('m2', { idOffset: secondOffset });
    useViewerStore.setState((state) => ({
      models: new Map([...state.models, [unrelated.id, unrelated]]),
      activeStorey: { modelId: 'm2', expressId: 5 },
      selectedStoreys: new Set([secondOffset + 5]),
    }));
    const { renderer, charts } = recordingRenderer();
    render(<ChartsPanel renderer={renderer} />);
    await settle();

    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    const before = useViewerStore.getState();
    const revision = before.selectionRevision;
    await act(async () => { useViewerStore.getState().removeModel('m2'); });
    await settle();
    const after = useViewerStore.getState();
    assert.equal(after.selectionRevision, revision, 'storey-only teardown is not an entity selection write');
    assert.deepEqual([...(after.chartSlice ?? [])].sort(), [GID(44), GID(45)]);
    assert.deepEqual([...(after.ghostExceptEntities ?? [])].sort(), [GID(44), GID(45)]);
  });

  it('does not reinstall a basket chart ghost after remount invalidates its scope (#4832)', async () => {
    const dashboard = modelOverviewDashboard();
    dashboard.scope = { kind: 'basket' };
    useViewerStore.setState({
      dashboards: [dashboard],
      activeDashboardId: dashboard.id,
      pinboardEntities: new Set(['m1:44', 'm1:45']),
    });
    const { renderer, charts } = recordingRenderer();
    render(<ChartsPanel renderer={renderer} />);
    await settle();
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 0 }] }); });
    await settle();
    assert.deepEqual([...(useViewerStore.getState().ghostExceptEntities ?? [])].sort(), [GID(44), GID(45)]);

    cleanup();
    useViewerStore.getState().clearPinboard();
    render(<ChartsPanel renderer={renderer} />);
    await settle();
    const state = useViewerStore.getState();
    assert.equal(state.chartSlice, null);
    assert.equal(state.ghostExceptEntities, null);
    assert.equal(state.chartVisibilityOwned, null);
  });

  it('preserves chart selection provenance across an unchanged tour snapshot round trip (#4832)', async () => {
    const { renderer, charts } = recordingRenderer();
    render(<ChartsPanel renderer={renderer} />);
    await settle();
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    const snapshot = captureUiSnapshot(useViewerStore);

    await act(async () => { restoreUiSnapshot(useViewerStore, snapshot); });
    await settle();
    const state = useViewerStore.getState();
    assert.equal(state.chartSelectionRevision, state.selectionRevision);
    assert.deepEqual([...(state.chartSlice ?? [])].sort(), [GID(44), GID(45)]);
    assert.deepEqual([...(state.ghostExceptEntities ?? [])].sort(), [GID(44), GID(45)]);
  });

  it('restores chart visibility provenance after the real clash-tour cleanup (#4832)', async () => {
    const { renderer, charts } = recordingRenderer();
    render(<ChartsPanel renderer={renderer} />);
    await settle();
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    const snapshot = captureUiSnapshot(useViewerStore);
    const zoomStep = CLASH_TOUR.steps.find((step) => step.id === 'zoom-to-clash');
    assert.ok(zoomStep?.cleanup);
    cleanup();

    await act(async () => {
      zoomStep.cleanup!(useViewerStore, {
        baseline: { hadResultAtEntry: 0 },
        artifacts: new Map(),
      });
      restoreUiSnapshot(useViewerStore, snapshot);
    });
    await settle();
    const state = useViewerStore.getState();
    assert.equal(state.chartSelectionRevision, state.selectionRevision);
    assert.equal(state.chartVisibilityRevision, state.visibilityRevision);
    assert.deepEqual([...(state.chartSlice ?? [])].sort(), [GID(44), GID(45)]);
    assert.deepEqual([...(state.ghostExceptEntities ?? [])].sort(), [GID(44), GID(45)]);
    assert.deepEqual(
      state.chartVisibilityOwned && {
        channel: state.chartVisibilityOwned.channel,
        ids: [...state.chartVisibilityOwned.ids].sort(),
      },
      { channel: 'ghost', ids: [GID(44), GID(45)] },
    );
  });

  it('does not revive chart visibility when a tour captured a foreign presentation (#4832)', async () => {
    const { renderer, charts } = recordingRenderer();
    render(<ChartsPanel renderer={renderer} />);
    await settle();
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    await act(async () => {
      installIdsFocusVisibility('isolate', new Set([GID(41)]));
    });
    const snapshot = captureUiSnapshot(useViewerStore);
    assert.equal(snapshot.selection.chartOwned, true);
    assert.equal(snapshot.selection.chartVisibilityOwned, null);
    cleanup();

    await act(async () => { restoreUiSnapshot(useViewerStore, snapshot); });
    render(<ChartsPanel renderer={renderer} />);
    await settle();
    const state = useViewerStore.getState();
    assert.deepEqual([...(state.chartSlice ?? [])].sort(), [GID(44), GID(45)]);
    assert.equal(state.chartVisibilityOwned, null);
    assert.equal(state.chartVisibilityRevision, null);
    assert.deepEqual([...(state.isolatedEntities ?? [])], [GID(41)]);
    assert.equal(state.ghostExceptEntities, null);
  });

  it('restores the captured chart bucket after tour steps replace its slice (#4832)', async () => {
    const { renderer, charts } = recordingRenderer();
    render(<ChartsPanel renderer={renderer} />);
    await settle();
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    const snapshot = captureUiSnapshot(useViewerStore);
    const capturedBuckets = snapshot.selection.chartSliceBuckets;

    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 0 }] }); });
    await settle();
    assert.deepEqual([...(useViewerStore.getState().chartSlice ?? [])].sort(), [GID(41), GID(42), GID(43)]);

    await act(async () => { restoreUiSnapshot(useViewerStore, snapshot); });
    await settle();
    const state = useViewerStore.getState();
    assert.equal(state.chartSelectionRevision, state.selectionRevision);
    assert.equal(state.chartSliceSource, snapshot.selection.chartSliceSource);
    assert.deepEqual(state.chartSliceBuckets, capturedBuckets);
    assert.deepEqual([...(state.chartSlice ?? [])].sort(), [GID(44), GID(45)]);
    assert.deepEqual([...(state.ghostExceptEntities ?? [])].sort(), [GID(44), GID(45)]);
  });

  it('restores captured chart ownership after a tour step clears the live slice (#4832)', async () => {
    const { renderer, charts } = recordingRenderer();
    render(<ChartsPanel renderer={renderer} />);
    await settle();
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    const snapshot = captureUiSnapshot(useViewerStore);

    await act(async () => { useViewerStore.getState().setSelectedEntityIds([GID(41)]); });
    await settle();
    assert.equal(useViewerStore.getState().chartSlice, null);
    assert.equal(useViewerStore.getState().ghostExceptEntities, null);

    await act(async () => { restoreUiSnapshot(useViewerStore, snapshot); });
    await settle();
    const state = useViewerStore.getState();
    assert.equal(state.chartSelectionRevision, state.selectionRevision);
    assert.deepEqual([...(state.chartSlice ?? [])].sort(), [GID(44), GID(45)]);
    assert.deepEqual([...(state.ghostExceptEntities ?? [])].sort(), [GID(44), GID(45)]);
  });

  it('drops an in-tour chart slice when the captured selection was ordinary (#4832)', async () => {
    const { renderer, charts } = recordingRenderer();
    render(<ChartsPanel renderer={renderer} />);
    await settle();
    const snapshot = captureUiSnapshot(useViewerStore);
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    cleanup();

    await act(async () => { restoreUiSnapshot(useViewerStore, snapshot); });
    const state = useViewerStore.getState();
    assert.equal(state.chartSlice, null);
    assert.equal(state.chartSliceSource, null);
    assert.equal(state.chartSliceBuckets, null);
    assert.equal(state.chartVisibilityOwned, null);
    assert.equal(state.ghostExceptEntities, null);
  });

  it('drops captured chart ownership when the model set changed during a tour (#4832)', async () => {
    const { renderer, charts } = recordingRenderer();
    render(<ChartsPanel renderer={renderer} />);
    await settle();
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    const snapshot = captureUiSnapshot(useViewerStore);
    const second = await parsedModel('m2', 2_000_000);
    useViewerStore.setState((state) => ({ models: new Map([...state.models, [second.id, second]]) }));
    cleanup();

    await act(async () => { restoreUiSnapshot(useViewerStore, snapshot); });
    const state = useViewerStore.getState();
    assert.equal(state.chartSlice, null);
    assert.equal(state.chartSliceSource, null);
    assert.equal(state.chartSliceBuckets, null);
    assert.equal(state.chartVisibilityOwned, null);
    assert.equal(state.ghostExceptEntities, null);
  });

  it('does not restore cached chart paint after every model is cleared (#4832)', async () => {
    const { renderer, charts } = recordingRenderer();
    const applied: number[][] = [];
    function MountedChartScene() {
      useOverlayCompositor();
      return <><ColorSceneProbe applied={applied} /><ChartsPanel renderer={renderer} /></>;
    }
    const ui = render(<MountedChartScene />);
    await settle();
    click(ui.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await settle();
    assert.equal(useViewerStore.getState().overlayLayers.get('charts')?.colorOverrides?.size, 5);
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    assert.deepEqual(applied.at(-1), [GID(44), GID(45)]);

    const beforeClear = applied.length;
    await act(async () => { useViewerStore.getState().clearAllModels(); });
    await settle();
    await settle();
    const state = useViewerStore.getState();
    assert.equal(state.models.size, 0);
    assert.equal(state.overlayLayers.has('charts'), false, 'an unmounted card aggregation cannot repaint removed model ids');
    assert.equal(state.pendingColorUpdates?.size ?? 0, 0, 'the mounted scene channel cannot receive removed ids again');
    const afterClear = applied.slice(beforeClear);
    assert.ok(afterClear.length > 0 && afterClear.every((ids) => ids.length === 0), 'the scene clears and never reapplies the cached five ids');
  });

  it('replaces a feedback-selected overlapping bucket in the same chart (#4832)', async () => {
    const dashboard = modelOverviewDashboard();
    dashboard.charts = [{
      ...dashboard.charts[0],
      title: 'Overlapping rules',
      source: 'clash',
      dimension: 'Rule',
      sort: 'label',
      topN: undefined,
    }];
    dashboard.layout = dashboard.layout.slice(0, 1);
    const clash = (id: string, rule: string, a: number, b: number): Clash => ({
      id,
      a: { key: `${id}-a`, ref: GID(a), model: 'm1', tag: 'IfcWall' },
      b: { key: `${id}-b`, ref: GID(b), model: 'm1', tag: 'IfcDoor' },
      rule,
      status: 'hard',
      distance: -0.05,
      point: [0, 0, 0],
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      severity: 'major',
    });
    const clashes = [
      clash('a1', 'Rule A', 41, 42),
      clash('a2', 'Rule A', 41, 44),
      clash('b1', 'Rule B', 41, 42),
    ];
    const clashResult: ClashResult = {
      clashes,
      summary: { total: 3, byRule: { 'Rule A': 2, 'Rule B': 1 }, byTypePair: {}, bySeverity: { critical: 0, major: 3, minor: 0, info: 0 } },
      rulesRun: [],
      settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
    };
    useViewerStore.setState({
      dashboards: [dashboard],
      activeDashboardId: dashboard.id,
      clashResult,
      clashRunSeq: useViewerStore.getState().clashRunSeq + 1,
    });
    const { renderer, charts } = recordingRenderer();
    render(<ChartsPanel renderer={renderer} />);
    await settle();

    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 0 }] }); });
    await settle();
    assert.deepEqual(barData(charts[0].options.at(-1)!), [['Rule A', 2, true], ['Rule B', 1, true]]);

    const replacement = selectionFromEChartEvent({
      fromAction: 'unselect',
      fromActionPayload: { seriesIndex: 0, dataIndex: 1 },
      selected: [{ seriesIndex: 0, dataIndex: [0] }],
    }, undefined, charts[0].events.canClearSelection);
    assert.deepEqual(replacement, { items: [{ seriesIndex: 0, dataIndex: 1 }] });
    await act(async () => { charts[0].events.onSelect(replacement); });
    await settle();
    const state = useViewerStore.getState();
    assert.deepEqual([...state.selectedEntityIds].sort(), [GID(41), GID(42)]);
    assert.deepEqual(state.chartSliceBuckets?.map(({ color: _color, ids: _ids, dataFingerprint: _fingerprint, ...identity }) => identity), [{ seriesKey: 'Rule', bucketKey: 'Rule B', isOther: false }]);
  });

  it('keeps clicked bucket identity when cross-filter removal reorders the source chart (#4832)', async () => {
    const dashboard = modelOverviewDashboard();
    dashboard.charts = [
      { ...dashboard.charts[0], title: 'Clashes by severity', source: 'clash', dimension: 'Severity', topN: undefined },
      { ...dashboard.charts[1], title: 'Clashes by rule', source: 'clash', type: 'bar', dimension: 'Rule', sort: undefined, topN: 1 },
    ];
    dashboard.layout = dashboard.layout.slice(0, 2);
    const clash = (id: string, rule: string, severity: Clash['severity'], a: number, b: number): Clash => ({
      id,
      a: { key: `${id}-a`, ref: GID(a), model: 'm1', tag: 'IfcWall' },
      b: { key: `${id}-b`, ref: GID(b), model: 'm1', tag: 'IfcDoor' },
      rule,
      status: 'hard',
      distance: -0.05,
      point: [0, 0, 0],
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      severity,
    });
    const clashes = [
      clash('a1', 'Rule A', 'critical', 41, 42),
      clash('a2', 'Rule A', 'critical', 41, 44),
      clash('b1', 'Rule B', 'critical', 43, 43),
      clash('b2', 'Rule B', 'major', 45, 45),
      clash('b3', 'Rule B', 'major', 46, 46),
    ];
    const clashResult: ClashResult = {
      clashes,
      summary: {
        total: clashes.length,
        byRule: { 'Rule A': 2, 'Rule B': 3 },
        byTypePair: {},
        bySeverity: { critical: 3, major: 2, minor: 0, info: 0 },
      },
      rulesRun: [],
      settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
    };
    useViewerStore.setState({
      dashboards: [dashboard],
      activeDashboardId: dashboard.id,
      clashResult,
      clashRunSeq: useViewerStore.getState().clashRunSeq + 1,
      clashGroups: null,
      clashReviews: new Map(),
      chartSlice: null,
      chartSliceSource: null,
      chartSliceBuckets: null,
      selectedEntityIds: new Set(),
      selectedEntitiesSet: new Set(),
      selectedEntities: [],
      overlayLayers: new Map(),
    });
    const { renderer, charts } = recordingRenderer();
    const ui = render(<ChartsPanel renderer={renderer} />);
    await settle();
    click(ui.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await settle();

    // Critical cross-filters rules to [A (2), B (1)]. Clicking A then makes
    // the rule chart the source, restoring [B (3), A (2)]. Since rules share
    // ids, a stored positional index 0 would let B overwrite A's clicked paint.
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 0 }] }); });
    await settle();
    const filteredRules = charts[1].options.at(-1)!;
    assert.deepEqual(barData(filteredRules).map(([name, value]) => [name, value]), [['Rule A', 2], ['Other', 1]]);
    const filteredSeries = filteredRules.series as Array<{ data: Array<{ name: string; itemStyle: { color: string } }> }>;
    const clickedColor = filteredSeries[0].data[0].itemStyle.color;

    await act(async () => { charts[1].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 0 }] }); });
    await settle();
    assert.deepEqual(barData(charts[1].options.at(-1)!).map(([name, value]) => [name, value]), [['Rule B', 3], ['Other', 2]]);
    const state = useViewerStore.getState();
    assert.deepEqual(state.chartSliceBuckets?.map(({ color: _color, ids: _ids, dataFingerprint: _fingerprint, ...identity }) => identity), [{ seriesKey: 'Rule', bucketKey: 'Rule A', isOther: false }]);
    assert.equal(state.chartSliceBuckets?.[0]?.color, clickedColor, 'the click-time colour survives folding into Other');
    assert.deepEqual([...state.selectedEntityIds].sort(), [GID(41), GID(42), GID(44)]);
    const expected = [
      Number.parseInt(clickedColor.slice(1, 3), 16) / 255,
      Number.parseInt(clickedColor.slice(3, 5), 16) / 255,
      Number.parseInt(clickedColor.slice(5, 7), 16) / 255,
      1,
    ];
    const colors = state.overlayLayers.get('charts')?.colorOverrides;
    assert.deepEqual(colors?.get(GID(41)), expected, 'shared id keeps clicked Rule A colour');
    assert.deepEqual(colors?.get(GID(42)), expected, 'second shared id keeps clicked Rule A colour');
    assert.deepEqual(colors?.get(GID(44)), expected);
    assert.equal(colors?.has(GID(43)), false, 'unselected Rule B context keeps authored colour');

    // Clear A, restore the critical filter, then click its gray synthetic
    // Other (Rule B / id 43). Re-expansion turns B into the named top bucket,
    // but the exact selected id must retain the color the user clicked.
    await act(async () => { charts[1].events.onSelect({ items: [] }); });
    await settle();
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 0 }] }); });
    await settle();
    const filteredAgain = (charts[1].options.at(-1)!.series as Array<{ data: Array<{ name: string; itemStyle: { color: string } }> }>)[0].data;
    assert.deepEqual(filteredAgain.map(({ name }) => name), ['Rule A', 'Other']);
    const otherColor = filteredAgain[1].itemStyle.color;
    await act(async () => { charts[1].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    const selectedOther = useViewerStore.getState();
    assert.deepEqual([...selectedOther.selectedEntityIds], [GID(43)]);
    const expectedOther = [
      Number.parseInt(otherColor.slice(1, 3), 16) / 255,
      Number.parseInt(otherColor.slice(3, 5), 16) / 255,
      Number.parseInt(otherColor.slice(5, 7), 16) / 255,
      1,
    ];
    assert.deepEqual(selectedOther.overlayLayers.get('charts')?.colorOverrides?.get(GID(43)), expectedOther, 'synthetic Other keeps its clicked gray after unfolding into named Rule B');

    const withoutSelectedRule: ClashResult = {
      ...clashResult,
      clashes: clashes.filter(({ rule }) => rule === 'Rule A'),
      summary: { ...clashResult.summary, total: 2, byRule: { 'Rule A': 2 }, bySeverity: { critical: 2, major: 0, minor: 0, info: 0 } },
    };
    await act(async () => {
      useViewerStore.getState().setSelectedEntityIds([GID(43)]);
      useViewerStore.getState().setSelectedEntityId(GID(43));
      useViewerStore.setState({ clashResult: withoutSelectedRule, clashRunSeq: useViewerStore.getState().clashRunSeq + 1 });
    });
    await settle();
    const preserved = useViewerStore.getState();
    assert.equal(preserved.chartSlice, null, 'a removed selected category cannot retain stale slice ownership');
    assert.deepEqual([...preserved.selectedEntityIds], [GID(43)], 'equal IDs do not make a newer independent pick chart-owned');
    assert.equal(preserved.ghostExceptEntities, null);

    await act(async () => { charts[1].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 0 }] }); });
    await settle();
    await act(async () => {
      useViewerStore.setState({
        clashResult: { ...withoutSelectedRule, clashes: [], summary: { ...withoutSelectedRule.summary, total: 0, byRule: {}, bySeverity: { critical: 0, major: 0, minor: 0, info: 0 } } },
        clashRunSeq: useViewerStore.getState().clashRunSeq + 1,
      });
    });
    await settle();
    const cleared = useViewerStore.getState();
    assert.equal(cleared.chartSlice, null);
    assert.equal(cleared.selectedEntityIds.size, 0, 'stale cleanup still clears the chart selection when it remains the current owner');
  });

  it('distinguishes synthetic top-N Other from a literal __other__ bucket (#4832)', async () => {
    const dashboard = modelOverviewDashboard();
    dashboard.charts = [{
      ...dashboard.charts[0],
      title: 'Top clash rules',
      source: 'clash',
      dimension: 'Rule',
      topN: 1,
    }];
    dashboard.layout = dashboard.layout.slice(0, 1);
    const clash = (id: string, rule: string, a: number, b: number): Clash => ({
      id,
      a: { key: `${id}-a`, ref: GID(a), model: 'm1', tag: 'IfcWall' },
      b: { key: `${id}-b`, ref: GID(b), model: 'm1', tag: 'IfcDoor' },
      rule,
      status: 'hard',
      distance: -0.05,
      point: [0, 0, 0],
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      severity: 'major',
    });
    const clashes = [
      clash('literal-1', '__other__', 41, 42),
      clash('literal-2', '__other__', 41, 44),
      clash('literal-3', '__other__', 42, 44),
      clash('tail-1', 'Tail 1', 41, 43),
      clash('tail-2', 'Tail 1', 43, 45),
      clash('tail-3', 'Tail 2', 45, 45),
    ];
    const clashResult: ClashResult = {
      clashes,
      summary: { total: clashes.length, byRule: { __other__: 3, 'Tail 1': 2, 'Tail 2': 1 }, byTypePair: {}, bySeverity: { critical: 0, major: 6, minor: 0, info: 0 } },
      rulesRun: [],
      settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
    };
    useViewerStore.setState({ dashboards: [dashboard], activeDashboardId: dashboard.id, clashResult, clashRunSeq: useViewerStore.getState().clashRunSeq + 1 });
    const { renderer, charts } = recordingRenderer();
    const ui = render(<ChartsPanel renderer={renderer} />);
    await settle();
    click(ui.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await settle();
    const data = (charts[0].options.at(-1)!.series as Array<{ data: Array<{ name: string; itemStyle: { color: string } }> }>)[0].data;
    assert.deepEqual(data.map((item) => item.name), ['__other__', 'Other']);
    const gray = data[1].itemStyle.color;

    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    const state = useViewerStore.getState();
    assert.deepEqual(state.chartSliceBuckets?.map(({ color: _color, ids: _ids, dataFingerprint: _fingerprint, ...identity }) => identity), [{ seriesKey: 'Rule', bucketKey: '__other__', isOther: true }]);
    const expected = [
      Number.parseInt(gray.slice(1, 3), 16) / 255,
      Number.parseInt(gray.slice(3, 5), 16) / 255,
      Number.parseInt(gray.slice(5, 7), 16) / 255,
      1,
    ];
    assert.deepEqual(state.overlayLayers.get('charts')?.colorOverrides?.get(GID(41)), expected, 'shared id keeps synthetic Other gray');
  });

  it('a click on a stacked segment selects only that series share of the category (review finding)', async () => {
    const { renderer, charts } = recordingRenderer();
    const ui = render(<ChartsPanel renderer={renderer} />);
    await settle();
    click(ui.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await settle();
    // The third seeded chart is "Types per storey": storey on the axis, one series per type.
    const option = charts[2].options.at(-1)!;
    const series = option.series as Array<{ name: string; data: Array<{ name: string; value: number; itemStyle: { color: string } }> }>;
    const doorSeries = series.findIndex((s) => s.name === 'IfcDoor');
    const level1 = series[doorSeries].data.findIndex((d) => d.name === 'Level 1');
    assert.ok(doorSeries >= 0 && level1 >= 0, JSON.stringify(series.map((s) => [s.name, s.data.map((d) => [d.name, d.value])])));
    const segmentColor = series[doorSeries].data[level1].itemStyle.color;
    await act(async () => { charts[2].events.onSelect({ items: [{ seriesIndex: doorSeries, dataIndex: level1 }] }); });
    await settle();
    // Level 1 holds walls A, B and door A; the door segment selects door A only.
    assert.deepEqual([...useViewerStore.getState().selectedEntityIds], [GID(44)]);
    assert.deepEqual(useViewerStore.getState().overlayLayers.get('charts')?.colorOverrides?.get(GID(44)), [
      Number.parseInt(segmentColor.slice(1, 3), 16) / 255,
      Number.parseInt(segmentColor.slice(3, 5), 16) / 255,
      Number.parseInt(segmentColor.slice(5, 7), 16) / 255,
      1,
    ]);
    // The other charts re-aggregate over that one door — singular, not "1 elements".
    assert.match(ui.querySelectorAll('[data-chart-subtitle]')[0]!.textContent!, /1 bucket · 1 element$/);
  });

  it('a chart over a source with no data yet says where the data comes from instead of drawing empty axes', async () => {
    const { renderer } = recordingRenderer();
    const ui = render(<ChartsPanel renderer={renderer} />);
    await settle();
    const picker = ui.querySelector<HTMLSelectElement>('select[aria-label="Dashboard"]')!;
    await act(async () => {
      picker.value = 'preset:Coordination';
      picker.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await settle();
    const empties = [...ui.querySelectorAll('[data-chart-empty]')].map((el) => el.textContent);
    // The Coordination preset mixes clash and BCF charts; each names its own source.
    assert.equal(empties.length, 8);
    assert.ok(empties.includes(EMPTY_HINTS.clash) && empties.includes(EMPTY_HINTS.bcf), empties.join(' | '));
    assert.ok(empties.every((t) => t === EMPTY_HINTS.clash || t === EMPTY_HINTS.bcf));
    assert.equal(ui.querySelector('[data-chart-subtitle]')?.textContent, 'No data');
  });

  it('lays the cards out in the dashboard grid, one grid item per chart, and offers the dashboard actions menu', async () => {
    const { renderer } = recordingRenderer();
    const ui = render(<ChartsPanel renderer={renderer} />);
    await settle();
    assert.ok(ui.querySelector('[data-dashboard-grid]'), 'the cards are in the grid');
    assert.equal(ui.querySelectorAll('[data-grid-item]').length, 3);
    assert.ok(ui.querySelector('button[aria-label="Dashboard actions"]'), 'rename / duplicate / delete / export / import live behind one menu');
  });

  it('the close button runs onClose and unmounting releases the claim the panel installed', async () => {
    const { renderer, charts } = recordingRenderer();
    let closed = 0;
    const ui = render(<ChartsPanel renderer={renderer} onClose={() => { closed += 1; }} />);
    await settle();
    click(ui.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await settle();
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    assert.ok(useViewerStore.getState().chartVisibilityOwned);
    const selected = useViewerStore.getState().selectedEntityIds;
    const livePaint = useViewerStore.getState().overlayLayers.get('charts')?.colorOverrides ?? null;
    assert.equal(chartAwareRendererSelectionFromStore(useViewerStore.getState().selectedEntityId, selected, livePaint).selectedIds.size, 0);
    click(ui.querySelector('button[aria-label="Close charts"]')!);
    assert.equal(closed, 1);
    cleanup();
    assert.equal(useViewerStore.getState().chartVisibilityOwned, null);
    assert.equal(useViewerStore.getState().ghostExceptEntities, null);
    assert.equal(useViewerStore.getState().overlayLayers.get('charts'), undefined);
    assert.equal(
      chartAwareRendererSelectionFromStore(useViewerStore.getState().selectedEntityId, selected, null).selectedIds,
      selected,
      'after paint teardown the logical selection returns to the ordinary renderer unchanged',
    );
  });

  it('removing the model releases the panel\'s claim and drops the slice', async () => {
    const { renderer, charts } = recordingRenderer();
    render(<ChartsPanel renderer={renderer} />);
    await settle();
    await act(async () => { charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 1 }] }); });
    await settle();
    await act(async () => { useViewerStore.getState().removeModel('m1'); });
    const s = useViewerStore.getState();
    assert.equal(s.chartSlice, null);
    assert.equal(s.chartVisibilityOwned, null);
  });
});

describe('overlapping chart bucket paint (#4832)', () => {
  it('keeps the clicked bucket colour authoritative for a shared entity', () => {
    const dataset: ChartDataset = {
      source: 'clash',
      columns: [{ id: 'Rule', label: 'Rule', kind: 'category' }],
      rows: [
        { ids: [1, 2], values: ['Rule A'] },
        { ids: [1, 3], values: ['Rule B'] },
      ],
      fingerprint: 'overlap',
    };
    const aggregation = aggregate({
      id: 'rules',
      title: 'Rules',
      source: 'clash',
      type: 'bar',
      dimension: 'Rule',
      measure: { agg: 'count' },
      sort: 'label',
    }, dataset);
    const clicked = { seriesKey: aggregation.series[0].key, bucketKey: aggregation.series[0].buckets[0].key, isOther: false, color: aggregation.series[0].buckets[0].color, ids: [...aggregation.series[0].buckets[0].ids] };
    const clickedColor = aggregation.series[0].buckets[0].color;
    const otherColor = aggregation.series[0].buckets[1].color;
    assert.notEqual(clickedColor, otherColor, 'the fixture must expose an overwrite');

    const colors = chartColorOverrides(aggregation, new Set([1, 2]), 'ghost', [clicked]);
    const expected = [
      Number.parseInt(clickedColor.slice(1, 3), 16) / 255,
      Number.parseInt(clickedColor.slice(3, 5), 16) / 255,
      Number.parseInt(clickedColor.slice(5, 7), 16) / 255,
      1,
    ];
    assert.deepEqual(colors.get(1), expected, 'shared id keeps clicked Rule A, not later Rule B');
    assert.deepEqual(colors.get(2), expected);
    assert.equal(colors.has(3), false, 'ghost context retains its authored colour');

    const second = {
      seriesKey: aggregation.series[0].key,
      bucketKey: aggregation.series[0].buckets[1].key,
      isOther: false,
      color: otherColor,
      ids: [...aggregation.series[0].buckets[1].ids],
    };
    const multi = chartColorOverrides(aggregation, new Set([1, 2, 3]), 'ghost', [clicked, second]);
    const expectedLast = [
      Number.parseInt(otherColor.slice(1, 3), 16) / 255,
      Number.parseInt(otherColor.slice(3, 5), 16) / 255,
      Number.parseInt(otherColor.slice(5, 7), 16) / 255,
      1,
    ];
    assert.deepEqual(multi.get(1), expectedLast, 'the later selected bucket deterministically wins a shared id');
    assert.deepEqual(multi.get(2), expected);
    assert.deepEqual(multi.get(3), expectedLast);
  });
});

describe('report export from the panel (#3944)', () => {
  beforeEach(async () => {
    const model = await parsedModel();
    useViewerStore.setState({ models: new Map([[model.id, model]]), activeModelId: model.id, dashboards: [], activeDashboardId: null, chartSlice: null, chartSliceSource: null, chartSliceBuckets: null, chartVisibilityOwned: null, selectedEntityIds: new Set(), overlayLayers: new Map(), cameraCallbacks: {} });
  });
  afterEach(() => cleanup());

  it('exports the seeded dashboard as a PDF through injected seams, downloads it, and remembers the page setup on the dashboard', async () => {
    const { renderer } = recordingRenderer();
    const drawn: string[] = [];
    let created: [string, string] | null = null;
    const seams = async (): Promise<ReportPdfSeams> => ({
      createDoc: async (format, orientation) => {
        created = [format, orientation];
        let pages = 1;
        return {
          addPage: () => { pages += 1; },
          setFont: () => {}, setFontSize: () => {}, setTextColor: () => {},
          text: (t) => { drawn.push(`text:${t}`); },
          addImage: () => { drawn.push('image'); },
          svg: async (svg) => { drawn.push(`svg:${svg.length > 100 ? 'ok' : 'short'}`); },
          table: (t) => { drawn.push(`table:${t.body.length}`); },
          pageCount: () => pages,
          output: () => new Blob(['pdf']),
        };
      },
      renderSvg: (aggregation, w, h, theme) => renderChartSvg({ aggregation, width: w, height: h, theme, showTitle: false }),
      capture: async (ids) => new Uint8Array(ids.length),
      theme: DEFAULT_THEME,
      now: () => new Date(0),
    });
    const downloads: string[] = [];
    const onDownload = (e: Event): void => { downloads.push(String((e as CustomEvent<{ kind: string }>).detail.kind)); };
    window.addEventListener(EVENT_FILE_DOWNLOADED, onDownload);
    try {
      const ui = render(<ChartsPanel renderer={renderer} reportSeams={seams} />);
      await settle();
      click(ui.querySelector('button[title="Print this dashboard to a PDF report"]')!);
      await settle();
      const dialog = document.querySelector('[data-report-dialog]');
      assert.ok(dialog, 'the report dialog opened');
      const size = dialog!.querySelector<HTMLSelectElement>('select[aria-label="Page size"]')!;
      await act(async () => { size.value = 'A3'; size.dispatchEvent(new window.Event('change', { bubbles: true })); });
      click(dialog!.querySelector('[data-report-export]')!);
      for (let i = 0; i < 20 && downloads.length === 0; i++) await settle();

      assert.deepEqual(created, ['a3', 'portrait']);
      assert.deepEqual(downloads, ['pdf']);
      // Three seeded charts: three vector charts, three snapshots, three tables.
      assert.equal(drawn.filter((d) => d === 'svg:ok').length, 3);
      assert.equal(drawn.filter((d) => d === 'image').length, 3);
      assert.equal(drawn.filter((d) => d.startsWith('table:')).length, 3);
      assert.ok(drawn.includes('text:Model overview'));
      const saved = useViewerStore.getState().dashboards[0] as ReportSpec;
      assert.deepEqual(saved.page, { size: 'A3', orientation: 'portrait' });
      assert.equal(saved.snapshots, true);
      assert.equal(typeof saved.titleBlock.date, 'string');
    } finally {
      window.removeEventListener(EVENT_FILE_DOWNLOADED, onDownload);
    }
  });
});
