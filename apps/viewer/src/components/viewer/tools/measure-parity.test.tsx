/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Both-toolbar guard for the Measure tool (#2199).
 *
 * The viewer ships two desktop toolbars at once — the classic `MainToolbar`
 * strip and the tabbed ribbon — and a user sits behind exactly one of them.
 * #2510 and #2511 close that gap for camera and export by giving each a single
 * ordered command registry plus a drift guard.
 *
 * Measure does not need a registry, and adding one would be the wrong fix: the
 * two toolbars do not host measurement UI at all. Each does one thing —
 * `setActiveTool('measure')` — and `ToolOverlays` renders the ONE panel off
 * that store field. There is no second list to drift from the first.
 *
 * What CAN drift is that structure itself, in three ways, and this file guards
 * each:
 *
 * 1. a toolbar stops dispatching `'measure'` (the ribbon-only search bug of
 *    #2510, in its measure-shaped form);
 * 2. a toolbar grows its own measurement UI beside the shared panel, which is
 *    how two hand-maintained lists get created in the first place;
 * 3. the shared panel stops hosting a section, so the section's own tests stay
 *    green while the feature ships unreachable — the exact hole #2510 and
 *    #2511 each found in their first guard.
 *
 * (3) is asserted by DRIVING `ToolOverlays`, the real host, not by rendering
 * the section components directly: a section is proven only by clicking its
 * button on the shipped panel and reading the numbers that come back.
 *
 * That same harness then earns its keep a second time. The last describe block
 * pins WHERE each printed number is allowed to come from — the instanced-only
 * volume side channel, the server-parsed quantity table, a federated model
 * whose volumes alignment invalidated, and the frame a picked point is
 * genuinely expressed in. Each of those is a place where a plausible number
 * can be printed from the wrong source, which is invisible to a test that only
 * checks a number appeared.
 *
 * (1) and (2) were asserted in SOURCE TEXT here, on the claim that neither
 * toolbar could be mounted in the node runner (`MainToolbar` drags in the whole
 * viewer; `HomeTab` reaches `@/icons`, a Vite virtual module). That claim is
 * false as of #2540's loader hooks: both mount, `ViewportContainer` mounts
 * given a WebGPU adapter and a loaded model, and `PropertiesPanel` mounts given
 * a real parsed store. So (1) is now a click on the Measure control with the
 * store read back, (2) is the absence of the panel's own controls in a mounted
 * toolbar, and the frame assertion is on the printed coordinate rather than on
 * the presence of a hook call (#2434).
 *
 * That matters beyond tidiness: the old form could not distinguish a control
 * that renders from a control that WORKS. `setActiveTool('measure')` written in
 * a handler that nothing invokes matched the regex exactly as well.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store/index.js';
import { useRenderFrameOffsets } from '@/hooks/useRenderFrameOffsets.js';
import { ToolOverlays } from '../ToolOverlays.js';
import { MainToolbar } from '../MainToolbar.js';
import { RibbonToolbar } from '../ribbon/RibbonToolbar.js';
import { HomeTab } from '../ribbon/tabs/HomeTab.js';
import { ViewportContainer } from '../ViewportContainer.js';
import { PropertiesPanel } from '../PropertiesPanel.js';
import * as formatDistanceModule from './formatDistance.js';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';

interface Vec3 { x: number; y: number; z: number }

/**
 * A real, fully-typed `IfcDataStore` from the actual columnar parser — the
 * Properties panel walks a `ModelQuery` over it (`getEntity`, `getProperties`,
 * `getQuantities`), which a hand-shaped stand-in cannot satisfy without
 * reimplementing the parser.
 */
const MINI_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#42=IFCWALL('0Wall00000000000000042',$,'Wall A',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

let miniStore: Promise<IfcDataStore> | null = null;
function parseMiniStore(): Promise<IfcDataStore> {
  if (!miniStore) {
    const bytes = new TextEncoder().encode(MINI_IFC);
    miniStore = new IfcParser().parseColumnar(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
  }
  return miniStore;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderNode(node: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<TooltipProvider>{node}</TooltipProvider>);
  });
  mounted.push({ root, container });
  return container;
}

const render = (): HTMLElement => renderNode(<ToolOverlays />);

/** A real bubbling click, the way it arrives at React's root listener. */
function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/** Let React flush an effect that resolves a promise (WebGPU detection). */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/**
 * happy-dom has no `navigator.gpu`, so `useWebGPU` reports unsupported and
 * `ViewportContainer` renders its fallback screen instead of the viewport.
 * Installed per-test rather than globally: every other test in this file
 * mounts `ToolOverlays` directly and must not depend on it.
 */
function useWebGpuStub(): () => void {
  const original = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  Object.defineProperty(navigator, 'gpu', {
    configurable: true,
    value: { requestAdapter: async () => ({ features: new Set(), limits: {} }) },
  });
  return () => {
    if (original) Object.defineProperty(navigator, 'gpu', original);
    else Reflect.deleteProperty(navigator, 'gpu');
  };
}

/**
 * The two surfaces that DISPATCH the tool. Both mount under the `src/test/`
 * loader hooks — this file's header used to claim neither could be, which is
 * why (1) and (2) were asserted in source text until #2434.
 */
const TOOLBARS = [
  { name: 'MainToolbar (classic)', Toolbar: MainToolbar },
  { name: 'HomeTab (ribbon)', Toolbar: HomeTab },
] as const;

/** The same two, but the ribbon at its ROOT — a toolbar could host the panel
 *  outside the tab body, which mounting HomeTab alone would not see. */
const TOOLBAR_ROOTS = [
  { name: 'MainToolbar (classic)', Toolbar: MainToolbar },
  { name: 'RibbonToolbar (ribbon root)', Toolbar: RibbonToolbar },
] as const;

/** The measure panel's own section buttons, which nothing else renders. */
function sectionButtons(container: HTMLElement): string[] {
  return [...container.querySelectorAll('button')]
    .map((b) => b.textContent?.trim() ?? '')
    .filter((label) => label === 'List' || label === 'Point' || label === 'Qty');
}

function assertNoMeasurePanel(container: HTMLElement, name: string): void {
  assert.deepEqual(sectionButtons(container), [], `${name} hosts measurement UI of its own`);
  assert.equal(
    container.textContent?.includes('Drag to measure'),
    false,
    `${name} hosts measurement UI of its own`,
  );
}

/**
 * The control a user clicks to enter the measure tool. Matched on the
 * accessible name, so a button that renders but is unlabelled — which is what
 * a screen-reader user would experience as "no Measure control" — fails here
 * rather than being found by a text scan of the whole toolbar.
 */
function measureControl(container: HTMLElement, name: string): Element {
  const found = [...container.querySelectorAll('button')].filter(
    (b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === 'Measure',
  );
  assert.equal(found.length, 1, `${name}: expected one Measure control, found ${found.length}`);
  return found[0];
}

/**
 * The LABEL of the coordinate row whose value matches `value`.
 *
 * Reads the rendered label cell rather than searching the panel text for the
 * word: the frame name also appears in the explanatory footnote and can appear
 * in a model's own name, so a text-wide `/Anchor/` would pass no matter what
 * the row is actually called.
 */
function coordRowLabel(container: HTMLElement, value: RegExp): string {
  const row = [...container.querySelectorAll('div')].find((d) => {
    const spans = d.querySelectorAll(':scope > span');
    return spans.length >= 2 && value.test(spans[1].textContent ?? '');
  });
  assert.ok(row, `no coordinate row whose value matches ${value}`);
  return row.querySelector(':scope > span')?.textContent?.trim() ?? '';
}

/** Click the panel's section button whose label is `label`. */
function openSection(container: HTMLElement, label: string): void {
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  );
  assert.ok(button, `no section button labelled "${label}" on the measure panel`);
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * Unmount everything from the previous test BEFORE the next one seeds the
 * store. A root left mounted re-renders on that seeding, which is both a
 * React act() warning and a live component reading a half-built state it would
 * never see in the app. Each root is unmounted in its OWN `act()`: batching
 * them into one would let a throw from the first leave the rest mounted.
 */
function unmountAll(): void {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
}

after(unmountAll);

/**
 * A measurement whose endpoints are chosen so every derived readout has a
 * DISTINCT expected value — a 3-4-5 triangle in the horizontal plane with a
 * 3 m rise, in renderer (Y-up) space.
 *
 * Renderer end point (3, 3, -4) is IFC (3, 4, 3): horizontal run 5, rise 3,
 * so 30.96 degrees, 60% and 1:1.7. Swapping any axis or dropping the northing
 * negation changes at least one printed number.
 */
/** `screenX`/`screenY` are the label anchors; nothing asserted here reads them. */
const START = { x: 0, y: 0, z: 0, screenX: 0, screenY: 0 };
const END = { x: 3, y: 3, z: -4, screenX: 0, screenY: 0 };

/**
 * A data store that resolves but declares nothing: zero-length `source` sends
 * the extractor down its pre-computed-table path, and that table is empty. It
 * isolates the geometry-volume half of the Qty section from the declared half.
 */
const EMPTY_STORE = {
  source: new Uint8Array(),
  quantities: { getForEntity: () => [] },
  relationships: null,
} as never;

beforeEach(() => {
  unmountAll();
  useViewerStore.setState({
    activeTool: 'measure',
    measurements: [],
    activeMeasurement: null,
    pendingMeasurePoint: null,
    measureReferencePoint: null,
    selectedEntity: null,
    selectedEntitiesSet: new Set<string>(),
    models: new Map(),
    ifcDataStore: null,
    geometryResult: null,
    unitDisplayOverrides: {},
  });
});

describe('measure tool is hosted once, for both toolbars', () => {
  it('renders the shared panel off activeTool alone, with all three sections', () => {
    const container = render();
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim());
    for (const section of ['List', 'Point', 'Qty']) {
      assert.ok(labels.includes(section), `missing "${section}" section button; saw ${labels.join(', ')}`);
    }
  });

  it('does not render the panel for another tool', () => {
    useViewerStore.setState({ activeTool: 'select' });
    const container = render();
    assert.equal(container.textContent?.includes('Drag to measure'), false);
  });

  for (const { name, Toolbar } of TOOLBARS) {
    it(`${name}: clicking Measure dispatches the tool`, () => {
      useViewerStore.setState({ activeTool: 'select' });
      const container = renderNode(<Toolbar />);

      click(measureControl(container, name));

      assert.equal(useViewerStore.getState().activeTool, 'measure');
    });

    it(`${name}: hosts no measurement UI of its own`, () => {
      // A toolbar that renders the panel or its sections is building the
      // second hand-maintained list this structure exists to avoid. Seeded
      // with a real measurement so a hosted panel would have something to
      // show — an empty one would be indistinguishable from no panel.
      useViewerStore.setState({
        activeTool: 'measure',
        measurements: [{ id: 'm1', start: START, end: END, distance: Math.hypot(3, 3, 4) }],
      });
      const container = renderNode(<Toolbar />);

      assertNoMeasurePanel(container, name);
    });
  }

  it('the shared panel is hosted by the viewport, not by either toolbar', async () => {
    // Both halves matter and neither implies the other: a panel nobody hosts
    // is a dead feature, and a panel two surfaces host is the drift this
    // structure exists to prevent. Asserted by mounting the three candidate
    // hosts and looking for the panel's own controls in each.
    //
    // `ViewportContainer` needs two things before it renders its real body:
    // a WebGPU adapter (otherwise it short-circuits to the "WebGPU Not
    // Available" screen) and a loaded model (otherwise the empty-state drop
    // zone). Both are seeded here rather than being reasons the assertion
    // "cannot" be behavioural.
    const restoreGpu = useWebGpuStub();
    try {
      useViewerStore.setState({
        activeTool: 'measure',
        measurements: [{ id: 'm1', start: START, end: END, distance: Math.hypot(3, 3, 4) }],
        models: new Map([['m1', federatedModel({ id: 'm1', geometryResult: { meshes: [], coordinateInfo: {} } })]]),
        activeModelId: 'm1',
      });

      const viewport = renderNode(<ViewportContainer />);
      await advance(10);
      assert.ok(
        sectionButtons(viewport).includes('List'),
        `the viewport must host the measure panel; saw ${sectionButtons(viewport).join(', ')}`,
      );

      for (const { name, Toolbar } of TOOLBAR_ROOTS) {
        assertNoMeasurePanel(renderNode(<Toolbar />), name);
      }
    } finally {
      // `finally`, not a trailing call: a failed assertion would otherwise
      // leave every later test in this file looking at a WebGPU-capable
      // navigator, which is the opposite of what the comment above promises.
      restoreGpu();
    }
  });
});

describe('the shipped panel hosts each #2199 section', () => {
  it('List shows inclination alongside the existing distance breakdown', () => {
    useViewerStore.setState({
      measurements: [{ id: 'm1', start: START, end: END, distance: Math.hypot(3, 3, 4) }],
    });
    const container = render();
    openSection(container, 'List');
    const text = container.textContent ?? '';
    // 3 m rise over a 5 m run: 30.96 degrees, 60.0%, 1:1.7.
    assert.match(text, /31\.0°/, `no inclination degrees in the List section: ${text}`);
    assert.match(text, /60\.0%/, `no slope percent in the List section: ${text}`);
    assert.match(text, /1:1\.7/, `no slope ratio in the List section: ${text}`);
  });

  it('Point shows the picked point in IFC axes, and its offset from a set reference', () => {
    useViewerStore.setState({
      measurements: [{ id: 'm1', start: START, end: END, distance: Math.hypot(3, 3, 4) }],
      // A datum one metre below the origin in renderer Y, i.e. IFC Z -1.
      measureReferencePoint: { x: 0, y: -1, z: 0 },
    });
    const container = render();
    openSection(container, 'Point');
    const text = container.textContent ?? '';
    // Renderer (3, 3, -4) -> IFC (3, 4, 3). The northing is +4, not -4: the
    // sign is what a dropped negation would flip.
    assert.match(text, /X 3\.000\s+Y 4\.000\s+Z 3\.000/, `wrong model coordinates: ${text}`);
    // Offset from IFC (0, 0, -1) is (3, 4, 4).
    assert.match(text, /X 3\.000\s+Y 4\.000\s+Z 4\.000/, `wrong relative offset: ${text}`);
  });

  it('Qty answers for an empty selection instead of rendering nothing', () => {
    const container = render();
    openSection(container, 'Qty');
    assert.match(container.textContent ?? '', /Select elements to read their quantities/);
  });

  it('Qty reports the kernel volume and states the openings convention beside it', () => {
    useViewerStore.setState({
      selectedEntitiesSet: new Set(['legacy:42']),
      ifcDataStore: EMPTY_STORE,
      geometryResult: {
        meshes: [
          // Two submeshes of ONE element, each carrying the same whole-entity
          // volume. Counting per mesh instead of per element would print 5.
          { expressId: 42, geometryVolume: 2.5 },
          { expressId: 42, geometryVolume: 2.5 },
        ],
      } as never,
    });
    const container = render();
    openSection(container, 'Qty');
    const text = container.textContent ?? '';
    assert.match(text, /Volume mesh\s*2\.5 m³/, `wrong mesh volume readout: ${text}`);
    assert.match(
      text,
      /net = openings excluded · gross = openings included · mesh = as built,\s*after opening cuts/,
      `the openings convention is not stated beside the numbers: ${text}`,
    );
  });

  it('Qty says why it has no answer rather than rendering an empty box', () => {
    useViewerStore.setState({
      // Selected, but no store resolves for the ref: nothing is declared and
      // nothing is proved.
      selectedEntitiesSet: new Set(['legacy:42']),
    });
    const container = render();
    openSection(container, 'Qty');
    const text = container.textContent ?? '';
    assert.match(text, /declares no quantities/, text);
    assert.match(text, /could not\s+be resolved to a loaded model/, text);
  });
});

/**
 * #2538 deep review, "major": all 14 tests #2199 added for the unit-override
 * fix are pure-function tests of `formatDistance` / `formatAxisDeltas` /
 * `formatHorizontalVertical` / `measurementOverlaysPropsEqual` — none of them
 * mount a component or read a rendered string, so deleting the
 * `unitDisplayOverrides` prop-threading at any of MeasurePanel.tsx's call
 * sites (or the store subscriptions feeding it) would leave the whole suite
 * green while the feature shipped dead.
 *
 * These drive the real path, exactly like the rest of this file: seed the
 * store with a `unitDisplayOverrides` LENGTHUNIT override, mount the shipped
 * `ToolOverlays`, click into a section, and read the printed string. A
 * mutation that drops any prop/subscription in the chain turns 'ft' back
 * into unconverted metres and one of these fails.
 */
describe('the LENGTHUNIT override reaches every rendered readout (#2538 wiring gap)', () => {
  // A 3.048 m run along X — exactly 10 ft at 0.3048 m/ft — so a dropped
  // conversion is visible as a wrong NUMBER, not just a wrong unit symbol.
  const FT_START = { x: 0, y: 0, z: 0, screenX: 0, screenY: 0 };
  const FT_END = { x: 3.048, y: 0, z: 0, screenX: 0, screenY: 0 };

  it('List: per-measurement distance and the multi-measurement Total both convert', () => {
    useViewerStore.setState({
      measurements: [
        { id: 'm1', start: FT_START, end: FT_END, distance: 3.048 },
        { id: 'm2', start: FT_START, end: FT_END, distance: 3.048 },
      ],
      unitDisplayOverrides: { LENGTHUNIT: 'ft' },
    });
    const container = render();
    openSection(container, 'List');
    const text = container.textContent ?? '';
    assert.match(text, /10 ft/, `per-measurement distance did not convert to ft: ${text}`);
    // Total of the two 10 ft measurements: 20 ft.
    assert.match(text, /20 ft/, `Total row did not convert to ft: ${text}`);
    assert.doesNotMatch(text, /6\.096/, `Total fell back to unconverted metres: ${text}`);
  });

  it('List: dX/dY/dZ and H/V breakdown lines convert', () => {
    useViewerStore.setState({
      measurements: [{ id: 'm1', start: FT_START, end: FT_END, distance: 3.048 }],
      unitDisplayOverrides: { LENGTHUNIT: 'ft' },
    });
    const container = render();
    openSection(container, 'List');
    const text = container.textContent ?? '';
    assert.match(text, /dX 10 ft\s+dY 0 ft\s+dZ 0 ft/, `axis-delta line did not convert to ft: ${text}`);
    assert.match(text, /H 10 ft\s+V 0 ft/, `horizontal\/vertical line did not convert to ft: ${text}`);
  });

  it('Point: the Rel. ref triple and its distance hint agree in the override unit', () => {
    useViewerStore.setState({
      measurements: [{ id: 'm1', start: FT_START, end: FT_END, distance: 3.048 }],
      // Reference point at the origin (renderer space) so the offset to the
      // live point (3.048, 0, 0) is exactly (3.048, 0, 0) again.
      measureReferencePoint: { x: 0, y: 0, z: 0 },
      unitDisplayOverrides: { LENGTHUNIT: 'ft' },
    });
    const container = render();
    openSection(container, 'Point');

    // Isolate the "Rel. ref" row specifically — the Model row above it stays
    // in unlabelled metres by design (#2199 scope), and DOES print "X 3.048"
    // for this same fixture, so a whole-panel text search cannot tell the two
    // apart.
    const relRefRow = [...container.querySelectorAll('div')].find(
      (d) => d.querySelector(':scope > span')?.textContent?.trim() === 'Rel. ref',
    );
    assert.ok(relRefRow, `no "Rel. ref" row rendered: ${container.textContent}`);
    const spans = relRefRow!.querySelectorAll(':scope > span');
    const value = spans[1]?.textContent ?? '';
    const hint = spans[2]?.textContent ?? '';

    // Renderer (3.048, 0, 0) -> IFC (3.048, 0, 0): dx=3.048 -> 10 ft.
    assert.match(value, /X 10\s+Y 0\s+Z 0/, `Rel. ref triple did not convert to ft: "${value}"`);
    assert.equal(hint, '10 ft', `Rel. ref distance hint did not convert to ft: "${hint}"`);
    // The failure mode this guards: hint converts but the triple stays in
    // unlabelled metres, e.g. "X 3.048  Y 0.000  Z 0.000" next to "10 ft".
    assert.doesNotMatch(value, /X 3\.048/, `Rel. ref triple fell back to unconverted metres: "${value}"`);
  });

  it('does not convert when unitDisplayOverrides is empty, as the control for the tests above', () => {
    useViewerStore.setState({
      measurements: [{ id: 'm1', start: FT_START, end: FT_END, distance: 3.048 }],
      unitDisplayOverrides: {},
    });
    const container = render();
    openSection(container, 'List');
    const text = container.textContent ?? '';
    assert.match(text, /3\.048 m/, `no-override case must stay in unconverted metres: ${text}`);
    assert.doesNotMatch(text, /10 ft/, text);
  });
});

/**
 * One federated model entry, minimal but REAL in the fields the panel reads:
 * `idOffset` (global-id maths), `federationAlignmentStatus` (volume trust and
 * frame provenance), `loadedAt` (which model owns the render frame) and
 * `coordinateInfo` (the shift to undo).
 */
function federatedModel(over: Record<string, unknown>) {
  return {
    id: 'm',
    name: 'model',
    ifcDataStore: EMPTY_STORE,
    geometryResult: null,
    visible: true,
    idOffset: 0,
    maxExpressId: 100000,
    loadedAt: 1,
    ...over,
  } as never;
}

describe('each printed number comes from the source it claims', () => {
  it('reads the proved volume of a GPU-instanced-only element from the side channel', () => {
    // The geometry pass drops the flat mesh for a fully instanced entity and
    // parks its volume here instead. `meshes` is EMPTY on purpose: an
    // implementation that only walks meshes reports this element as having no
    // provable volume while the answer is right there.
    useViewerStore.setState({
      selectedEntitiesSet: new Set(['legacy:42']),
      ifcDataStore: EMPTY_STORE,
      geometryResult: {
        meshes: [],
        instancedGeometryVolumes: new Map([[42, 3.25]]),
      } as never,
    });
    const container = render();
    openSection(container, 'Qty');
    const text = container.textContent ?? '';
    assert.match(text, /Volume mesh\s*3\.25 m³/, `instanced-only volume not reported: ${text}`);
  });

  it('reads type-declared quantities on the server-parsed path, where the source is empty', () => {
    // `store.source` is zero-length, which is what a server-parsed store looks
    // like — the on-demand TYPE extractor returns null outright there, and the
    // type's own sets live in the prebuilt table keyed by the TYPE's id.
    const SERVER_STORE = {
      source: new Uint8Array(),
      relationships: { getRelated: () => [7] },
      quantities: {
        getForEntity: (id: number) =>
          id === 7
            ? [{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'NetVolume', type: 2, value: 4 }] }]
            : [],
      },
    } as never;
    useViewerStore.setState({
      selectedEntitiesSet: new Set(['legacy:42']),
      ifcDataStore: SERVER_STORE,
      geometryResult: null,
    });
    const container = render();
    openSection(container, 'Qty');
    const text = container.textContent ?? '';
    assert.match(text, /Volume net\s*4 m³/, `type quantities lost on the server path: ${text}`);
  });

  it('reports a federated model\'s proved volume when alignment left its vertices alone', () => {
    useViewerStore.setState({
      selectedEntitiesSet: new Set(['m1:42']),
      models: new Map([['m1', federatedModel({
        id: 'm1',
        federationAlignmentStatus: 'anchor',
        geometryResult: { meshes: [{ expressId: 42, geometryVolume: 2.5 }] },
      })]]),
    });
    const container = render();
    openSection(container, 'Qty');
    const text = container.textContent ?? '';
    assert.match(text, /Volume mesh\s*2\.5 m³/, `an anchored model's volume must be reported: ${text}`);
    assert.doesNotMatch(text, /withheld/, text);
  });

  it('withholds — and explains — the proved volume of a model alignment rescaled', () => {
    // Same model, same stored volume; only the alignment status differs. #1993:
    // 'reprojected' re-baked every vertex through a map carrying a scale, so
    // the stored 2.5 m³ describes geometry at a size that is no longer drawn.
    useViewerStore.setState({
      selectedEntitiesSet: new Set(['m1:42']),
      models: new Map([['m1', federatedModel({
        id: 'm1',
        federationAlignmentStatus: 'reprojected',
        geometryResult: { meshes: [{ expressId: 42, geometryVolume: 2.5 }] },
      })]]),
    });
    const container = render();
    openSection(container, 'Qty');
    const text = container.textContent ?? '';
    assert.doesNotMatch(text, /2\.5 m³/, `a rescaled model's stale volume was printed: ${text}`);
    assert.match(text, /federation alignment rescaled/, `the withholding is not explained: ${text}`);
    // NOT folded into the kernel's "could not prove" count: those are two
    // different statements and the panel must not blur them.
    assert.doesNotMatch(text, /had no\s+provable enclosed volume/, text);
  });

  it('labels a picked point Model when no model was re-based into the scene frame', () => {
    useViewerStore.setState({
      measurements: [{ id: 'm1', start: START, end: END, distance: Math.hypot(3, 3, 4) }],
      models: new Map([['m1', federatedModel({
        id: 'm1',
        name: 'Base file',
        federationAlignmentStatus: 'anchor',
        geometryResult: { meshes: [], coordinateInfo: {} },
      })]]),
    });
    const container = render();
    openSection(container, 'Point');
    assert.equal(coordRowLabel(container, /X 3\.000/), 'Model');
    assert.doesNotMatch(container.textContent ?? '', /re-based/, container.textContent ?? '');
  });

  it('labels a picked point Anchor once alignment re-based another model into the frame', () => {
    useViewerStore.setState({
      measurements: [{ id: 'm1', start: START, end: END, distance: Math.hypot(3, 3, 4) }],
      models: new Map([
        ['m1', federatedModel({
          id: 'm1',
          name: 'Base file',
          loadedAt: 1,
          federationAlignmentStatus: 'anchor',
          geometryResult: { meshes: [], coordinateInfo: {} },
        })],
        ['m2', federatedModel({
          id: 'm2',
          name: 'Second file',
          loadedAt: 2,
          federationAlignmentStatus: 'same-crs',
          geometryResult: { meshes: [], coordinateInfo: {} },
        })],
      ]),
    });
    const container = render();
    openSection(container, 'Point');
    const text = container.textContent ?? '';
    // The numbers are unchanged — they are the scene's frame either way. What
    // changes is the claim made about whose coordinate system they are in.
    assert.match(text, /X 3\.000\s+Y 4\.000\s+Z 3\.000/, `coordinates changed: ${text}`);
    assert.equal(
      coordRowLabel(container, /X 3\.000/),
      'Anchor',
      `the row is still labelled as the picked file's own: ${text}`,
    );
    assert.match(text, /re-based one or more models into Base file's frame/, text);
  });
});

describe('the relative-coordinate datum belongs to the scene it was picked in', () => {
  it('survives clearing the measurement list', () => {
    useViewerStore.setState({ measureReferencePoint: { x: 1, y: 2, z: 3 } });
    useViewerStore.getState().clearMeasurements();
    assert.deepEqual(
      useViewerStore.getState().measureReferencePoint,
      { x: 1, y: 2, z: 3 },
      'tidying a distance list must not move the user\'s setting-out origin',
    );
  });

  it('is dropped when a new primary file replaces the scene', () => {
    // The datum is stored in RENDERER space. Carried into the next model it
    // would subtract a point from the outgoing scene and print a plausible,
    // meaningless offset.
    useViewerStore.setState({ measureReferencePoint: { x: 1, y: 2, z: 3 } });
    useViewerStore.getState().resetViewerState();
    assert.equal(useViewerStore.getState().measureReferencePoint, null);
  });
});

describe('guard sanity', () => {
  // The "reads real toolbar sources" length check that used to open this block
  // is gone with the reads it guarded (#2434). Its job — "the thing under test
  // actually resolved" — is now done by the mounts themselves: `measureControl`
  // asserts exactly ONE Measure control per toolbar, which an empty or failed
  // render cannot satisfy.

  it('formatDistance is the ONE distance formatter — no unguarded second name to pick wrong (#2538)', () => {
    // #2199 briefly shipped `formatDistanceDisplay` beside an
    // unconditionally-metric `formatDistance`, exported side by side with no
    // guard stopping a new measure readout from calling the wrong one — which
    // is exactly what the maintainer reported was still happening on the
    // live `feat/measurement-tools` branch. The override handling was folded
    // into `formatDistance` itself; this pins that there is only one name to
    // find and call from here on.
    //
    // Asked of the loaded module rather than of its source text (#2551). A
    // second formatter is caught however it is spelled or re-exported, and the
    // four per-consumer source reads this replaces are covered for free: a call
    // site reaching for a name the module does not export cannot typecheck.
    const distanceFormatters = Object.keys(formatDistanceModule)
      .filter((name) => name.startsWith('formatDistance'))
      .sort();
    assert.deepEqual(
      distanceFormatters,
      ['formatDistance'],
      'a second, override-aware distance formatter has appeared beside formatDistance — fold it back in instead of exporting two names',
    );
  });

  describe('one frame per scene, resolved in one place', () => {
    it('takes BOTH offsets from the same (earliest) model', () => {
      // The defect this pins is a MIX: the anchor's `wasmRtcOffset` with the
      // selected model's `originShift`. The two models below carry offsets that
      // are distinguishable on every axis, so any cross-pairing is visible.
      const seen: Array<{ originShift: unknown; wasmRtcOffsetIfc: unknown }> = [];
      function Probe() {
        const f = useRenderFrameOffsets();
        seen.push({ originShift: f.originShift, wasmRtcOffsetIfc: f.wasmRtcOffsetIfc });
        return null;
      }
      useViewerStore.setState({
        geometryResult: null,
        models: new Map([
          ['m1', federatedModel({
            id: 'm1', loadedAt: 1, federationAlignmentStatus: 'anchor',
            geometryResult: { meshes: [], coordinateInfo: {
              originShift: { x: 1, y: 2, z: 3 },
              wasmRtcOffset: { x: 10, y: 20, z: 30 },
            } },
          })],
          ['m2', federatedModel({
            id: 'm2', loadedAt: 2, federationAlignmentStatus: 'identity',
            geometryResult: { meshes: [], coordinateInfo: {
              originShift: { x: 7, y: 8, z: 9 },
              wasmRtcOffset: { x: 70, y: 80, z: 90 },
            } },
          })],
        ]),
      });
      const host = document.createElement('div');
      document.body.appendChild(host);
      const probeRoot = createRoot(host);
      try {
        act(() => probeRoot.render(<Probe />));
        assert.deepEqual(seen.at(-1), {
          originShift: { x: 1, y: 2, z: 3 },
          wasmRtcOffsetIfc: { x: 10, y: 20, z: 30 },
        }, 'both offsets must come from the earliest-loaded model');
      } finally {
        act(() => probeRoot.unmount());
        host.remove();
        useViewerStore.setState({ models: new Map() });
      }
    });

    it('the Properties panel prints the anchor\'s frame, not the selected model\'s', async () => {
      // A second copy of "which model owns the frame" is how the two readouts
      // drifted in the first place, and the defect is a MIX: the anchor's
      // `wasmRtcOffset` with the SELECTED model's `originShift`. Asserted on
      // the printed number rather than on the presence of a call — a call can
      // be there and its result ignored (#2434).
      //
      // Selected element sits at renderer-local centre (1, 1, 1) in m2, while
      // m1 is the anchor. Through the anchor's frame that prints
      // E 12 / N 16 / Z 33; taking `originShift` from m2 instead prints
      // E 18 / N 10 / Z 39 — a different value on every axis.
      const parsed = await parseMiniStore();
      const withFrame = (id: string, loadedAt: number, idOffset: number, shift: Vec3, rtc: Vec3, meshes: unknown[]) =>
        federatedModel({
          id, loadedAt, idOffset, ifcDataStore: parsed,
          geometryResult: { meshes, coordinateInfo: { originShift: shift, wasmRtcOffset: rtc } },
        });

      useViewerStore.setState({
        models: new Map([
          ['m1', withFrame('m1', 1, 0, { x: 1, y: 2, z: 3 }, { x: 10, y: 20, z: 30 }, [])],
          ['m2', withFrame('m2', 2, 1000, { x: 7, y: 8, z: 9 }, { x: 70, y: 80, z: 90 }, [
            { expressId: 1042, positions: new Float32Array([0, 0, 0, 2, 2, 2]) },
          ])],
        ]),
        activeModelId: 'm2',
        selectedEntity: { modelId: 'm2', expressId: 42 },
        selectedEntityId: 1042,
        geometryResult: null,
      });

      const container = renderNode(<PropertiesPanel />);
      const text = container.textContent ?? '';
      // `\s` and not a literal space: `CoordVal` separates the axis letter from
      // its value with U+2009 THIN SPACE, which an ASCII space does not match.
      assert.match(text, /E\s12\.000\s+N\s16\.000\s+Z\s33\.000/, `wrong world centre: ${text.slice(0, 200)}`);
    });
  });

  describe('a quantity is only ever read from the element\'s OWN model', () => {
    it('does not fall back to the legacy store for an unresolved federated ref', () => {
      // A federated id that is not in `models` must be REPORTED as unresolved,
      // not answered from whichever store happens to be lying around: the same
      // express id in another file is a different element.
      useViewerStore.setState({
        selectedEntitiesSet: new Set(['ghost-model:42']),
        models: new Map([['m1', federatedModel({ id: 'm1' })]]),
        ifcDataStore: {
          source: new Uint8Array(),
          relationships: null,
          quantities: {
            getForEntity: () => [
              { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'NetVolume', type: 2, value: 99 }] },
            ],
          },
        } as never,
      });
      const container = render();
      openSection(container, 'Qty');
      const text = container.textContent ?? '';
      assert.doesNotMatch(text, /99/, `another model's quantity was reported as this element's: ${text}`);
      assert.match(text, /could not\s+be resolved to a loaded model/, text);
    });

    it('still answers a legacy ref from the legacy store', () => {
      // The control: narrowing the fallback must not break the single-model
      // path, which is the common one.
      useViewerStore.setState({
        selectedEntitiesSet: new Set(['legacy:42']),
        models: new Map(),
        ifcDataStore: {
          source: new Uint8Array(),
          relationships: null,
          quantities: {
            getForEntity: () => [
              { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'NetVolume', type: 2, value: 5 }] },
            ],
          },
        } as never,
      });
      const container = render();
      openSection(container, 'Qty');
      assert.match(container.textContent ?? '', /Volume net\s*5 m³/, container.textContent ?? '');
    });
  });
});
