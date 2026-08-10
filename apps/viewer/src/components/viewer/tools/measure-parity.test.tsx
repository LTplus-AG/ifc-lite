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
 * (1) and (2) are asserted in source with import statements stripped first —
 * neither toolbar can be mounted in the node runner (`MainToolbar` drags in the
 * whole viewer; `HomeTab` reaches `@/icons`, a Vite virtual module), and an
 * import line left behind after the JSX was deleted is precisely what kept
 * #2510's first guard green on the regression it existed to catch.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store/index.js';
import { ToolOverlays } from '../ToolOverlays.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** Source with every `import ... from '...'` statement removed, so a leftover
 *  import can never stand in for a rendered control. */
function withoutImports(source: string): string {
  return source.replace(/^\s*import\s[\s\S]*?from\s*['"][^'"]+['"];?\s*$/gm, '');
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function render(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ToolOverlays />);
  });
  mounted.push({ root, container });
  return container;
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

  it('both toolbars dispatch the measure tool, and neither hosts measurement UI of its own', () => {
    const surfaces: Array<{ name: string; source: string }> = [
      { name: 'MainToolbar (classic)', source: withoutImports(read('../MainToolbar.tsx')) },
      { name: 'HomeTab (ribbon)', source: withoutImports(read('../ribbon/tabs/HomeTab.tsx')) },
    ];

    for (const { name, source } of surfaces) {
      assert.match(
        source,
        /(setActiveTool\(\s*'measure'\s*\)|tool="measure")/,
        `${name} no longer dispatches the measure tool`,
      );
      // A toolbar that reaches for the panel or its sections is building the
      // second hand-maintained list this structure exists to avoid.
      assert.doesNotMatch(
        source,
        /Measure(Overlay|Panel|Quantities|PointReadout)/,
        `${name} hosts measurement UI of its own; it must only set the tool`,
      );
    }
  });

  it('ToolOverlays is mounted in one shared place, not per toolbar', () => {
    const hosts = ['ViewportContainer.tsx', 'MainToolbar.tsx', 'ribbon/RibbonToolbar.tsx'].filter(
      (f) => /<ToolOverlays\s*\/>/.test(withoutImports(read(`../${f}`))),
    );
    assert.deepEqual(hosts, ['ViewportContainer.tsx']);
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
        name: 'Anchor file',
        federationAlignmentStatus: 'anchor',
        geometryResult: { meshes: [], coordinateInfo: {} },
      })]]),
    });
    const container = render();
    openSection(container, 'Point');
    const text = container.textContent ?? '';
    assert.match(text, /Model/, text);
    assert.doesNotMatch(text, /Anchor coordinates|re-based/, text);
  });

  it('labels a picked point Anchor once alignment re-based another model into the frame', () => {
    useViewerStore.setState({
      measurements: [{ id: 'm1', start: START, end: END, distance: Math.hypot(3, 3, 4) }],
      models: new Map([
        ['m1', federatedModel({
          id: 'm1',
          name: 'Anchor file',
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
    assert.match(text, /Anchor/, `the row is still labelled as the picked file's own: ${text}`);
    assert.match(text, /re-based one or more models into Anchor file's frame/, text);
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

/** The path assertions above are only meaningful if the files exist. */
describe('guard sanity', () => {
  it('reads real toolbar sources', () => {
    for (const rel of ['../MainToolbar.tsx', '../ribbon/tabs/HomeTab.tsx', '../ViewportContainer.tsx']) {
      assert.ok(read(rel).length > 500, `${rel} did not resolve to real source (from ${here})`);
    }
  });
});
