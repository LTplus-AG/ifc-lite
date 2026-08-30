/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The live 2D drawing canvas half of the gap PR #3523 fixed for the export
 * paths: every `ElementData` this component built for the graphic-override
 * rule engine set only `expressId`/`ifcType`, never `.properties`, so the
 * built-in "Fire Safety" preset's `FireRating`-gated rule
 * (`packages/drawing-2d/src/graphic-overrides/presets.ts`) could never win
 * over its lower-priority base rule on screen, no matter how an element was
 * rated -- only the exported SVG/PDF (fixed by #3523) honoured it.
 *
 * This test drives the real canvas rendering path with `ElementData` built
 * exactly the way the production draw loop builds it (via
 * `useDrawingElementPropertiesLookup`, not a stub), a `FireRating`-style
 * rule mirroring the shipped preset's own rule shape, and an `ifcType`-only
 * control rule that always matches -- isolating the assertion to the
 * property path, the same control #3523's export-side test used.
 *
 * It also counts every `extractPropertiesOnDemand` call to show property
 * extraction happens once (per distinct entityId in the polygon set), never
 * once per draw -- the requirement `useDrawingElementPropertiesLookup.ts`
 * exists to satisfy (its `useMemo` is keyed on the polygon/model set, not on
 * `transform`, which is what the draw loop's own `useEffect` keys on).
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import {
  GraphicOverrideEngine,
  ifcTypeCriterion,
  propertyCriterion,
  andCriteria,
  type Drawing2D,
  type GraphicOverrideRule,
} from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import { Drawing2DCanvas } from './Drawing2DCanvas.js';

installLayout();

// ─── Fixture: one IfcWall with Pset_WallCommon.FireRating = 120 ────────────

function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

const WALL_EXPRESS_ID = 72;

const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#72= IFCWALL('${guid('WALA')}',$,'Wall A',$,$,$,$,'tagA',$);
#84= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCINTEGER(120),$);
#83= IFCPROPERTYSET('${guid('PST1')}',$,'Pset_WallCommon',$,(#84));
#85= IFCRELDEFINESBYPROPERTIES('${guid('RDP1')}',$,$,$,(#72),#83);
ENDSEC;
END-ISO-10303-21;
`;

// Same wall, but its properties arrive in TWO property sets that share the
// name `Pset_WallCommon` -- one attached by #85, one by #95, exactly how a
// type-level set and an occurrence-level set reach the same occurrence in a
// real file. `extractPropertiesOnDemand` returns them as two separate
// entries and does not merge them, so a flattening that keys the record by
// set name and assigns outright drops every property of the first set.
const MODEL_DUPLICATE_PSET_NAMES = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#72= IFCWALL('${guid('WALA')}',$,'Wall A',$,$,$,$,'tagA',$);
#84= IFCPROPERTYSINGLEVALUE('LoadBearing',$,IFCBOOLEAN(.T.),$);
#83= IFCPROPERTYSET('${guid('PST1')}',$,'Pset_WallCommon',$,(#84));
#85= IFCRELDEFINESBYPROPERTIES('${guid('RDP1')}',$,$,$,(#72),#83);
#94= IFCPROPERTYSINGLEVALUE('Reference',$,IFCLABEL('W01'),$);
#93= IFCPROPERTYSET('${guid('PST2')}',$,'Pset_WallCommon',$,(#94));
#95= IFCRELDEFINESBYPROPERTIES('${guid('RDP2')}',$,$,$,(#72),#93);
ENDSEC;
END-ISO-10303-21;
`;

async function parseModel(source: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(source);
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

async function parseFixture(): Promise<IfcDataStore> {
  return parseModel(MODEL);
}

// ─── Rules: mirror the shipped Fire Safety preset's own rule shape ─────────

const BASE_RULE: GraphicOverrideRule = {
  id: 'base-ifctype',
  name: 'Walls - base',
  enabled: true,
  priority: 100,
  criteria: ifcTypeCriterion(['IfcWall']),
  style: { fillColor: '#AAAAAA' },
};

const FIRE_RULE: GraphicOverrideRule = {
  id: 'fire-rated',
  name: 'Fire Rated 2hr+',
  enabled: true,
  priority: 200,
  criteria: andCriteria(ifcTypeCriterion(['IfcWall']), propertyCriterion('FireRating', 'greaterOrEqual', 120)),
  style: { fillColor: '#FF0000' },
};

const EMPTY_DRAWING: Drawing2D = {
  config: {
    plane: { axis: 'y', position: 0, flipped: false },
    projectionDepth: 10,
    includeHiddenLines: true,
    creaseAngle: 30,
    scale: 100,
  },
  lines: [],
  cutPolygons: [
    {
      polygon: { outer: [], holes: [] },
      entityId: WALL_EXPRESS_ID,
      ifcType: 'IfcWall',
      modelIndex: 0,
      isCut: true,
    },
  ],
  projectionPolygons: [],
  bounds: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } },
  stats: {
    cutLineCount: 0,
    projectionLineCount: 0,
    hiddenLineCount: 0,
    silhouetteLineCount: 0,
    polygonCount: 1,
    totalTriangles: 0,
    processingTimeMs: 0,
  },
};

/** Records every `fillStyle`/`strokeStyle` assignment (in order) so the test
 *  can inspect exactly what colour the wall's fill loop resolved, without a
 *  real 2D rendering backend (happy-dom implements `<canvas>` but not 2D). */
function installCanvasStub(): { fillStyleCalls: string[]; restore: () => void } {
  const fillStyleCalls: string[] = [];
  const store = new Map<string | symbol, unknown>();
  const ctx = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'canvas') return { width: 800, height: 600 };
        if (store.has(prop)) return store.get(prop);
        return () => undefined;
      },
      set(_target, prop, value) {
        if (prop === 'fillStyle') fillStyleCalls.push(String(value));
        store.set(prop, value);
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;

  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = ((kind: string) =>
    kind === '2d' ? ctx : null) as unknown as typeof HTMLCanvasElement.prototype.getContext;

  return {
    fillStyleCalls,
    restore: () => {
      HTMLCanvasElement.prototype.getContext = original;
    },
  };
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderCanvas(overrideEngine: GraphicOverrideEngine): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <Drawing2DCanvas
        drawing={EMPTY_DRAWING}
        transform={{ x: 0, y: 0, scale: 1 }}
        showHiddenLines={false}
        overrideEngine={overrideEngine}
        overridesEnabled={true}
        entityColorMap={new Map()}
        useIfcMaterials={false}
        sectionAxis="down"
      />,
    );
  });
  mounted.push({ root, container });
}

describe('Drawing2DCanvas live-canvas property overrides (#3523 gap: the export half only)', () => {
  beforeEach(async () => {
    useViewerStore.getState().setIfcDataStore(await parseFixture());
  });

  afterEach(() => {
    useViewerStore.getState().setIfcDataStore(null);
    for (const { root, container } of mounted.splice(0)) {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('the FireRating rule wins over the base rule (GREEN, was RED before the fix)', () => {
    const stub = installCanvasStub();
    try {
      renderCanvas(new GraphicOverrideEngine([BASE_RULE, FIRE_RULE]));
      assert.ok(
        stub.fillStyleCalls.includes('#FF0000'),
        `expected the FireRating rule's fill colour "#FF0000" to have been used; got ${JSON.stringify(stub.fillStyleCalls)}`,
      );
      assert.ok(
        !stub.fillStyleCalls.includes('#AAAAAA'),
        `the base rule's fill colour "#AAAAAA" should have lost to the higher-priority FireRating rule; got ${JSON.stringify(stub.fillStyleCalls)}`,
      );
    } finally {
      stub.restore();
    }
  });

  it('control: an ifcType-only rule always matches regardless of properties', () => {
    const stub = installCanvasStub();
    try {
      renderCanvas(new GraphicOverrideEngine([BASE_RULE]));
      assert.ok(
        stub.fillStyleCalls.includes('#AAAAAA'),
        `expected the base ifcType-only rule to match; got ${JSON.stringify(stub.fillStyleCalls)}`,
      );
    } finally {
      stub.restore();
    }
  });

  it('merges two property sets that share a name instead of letting the second erase the first', async () => {
    useViewerStore.getState().setIfcDataStore(await parseModel(MODEL_DUPLICATE_PSET_NAMES));

    // Both halves of the merge are asserted at once: `LoadBearing` lives only
    // on the FIRST `Pset_WallCommon` and `Reference` only on the SECOND, so
    // this rule can only win if the flattening is a union of the two. Keeping
    // just the last set (what assigning by set name does) loses `LoadBearing`;
    // keeping just the first loses `Reference`. Either way the base rule's
    // #AAAAAA wins instead of #0000FF -- two distinct colours, so the fixture
    // discriminates.
    const mergedRule: GraphicOverrideRule = {
      id: 'load-bearing-and-reference',
      name: 'Load-bearing wall W01',
      enabled: true,
      priority: 200,
      criteria: andCriteria(
        ifcTypeCriterion(['IfcWall']),
        propertyCriterion('LoadBearing', 'equals', true, 'Pset_WallCommon'),
        propertyCriterion('Reference', 'equals', 'W01', 'Pset_WallCommon'),
      ),
      style: { fillColor: '#0000FF' },
    };

    const stub = installCanvasStub();
    try {
      renderCanvas(new GraphicOverrideEngine([BASE_RULE, mergedRule]));
      assert.ok(
        stub.fillStyleCalls.includes('#0000FF'),
        `expected properties from BOTH same-named "Pset_WallCommon" sets to survive flattening, so the higher-priority rule wins with "#0000FF"; got ${JSON.stringify(stub.fillStyleCalls)}`,
      );
      assert.ok(
        !stub.fillStyleCalls.includes('#AAAAAA'),
        `the base rule's "#AAAAAA" should have lost to the merged-property rule; got ${JSON.stringify(stub.fillStyleCalls)}`,
      );
    } finally {
      stub.restore();
    }
  });

  it('never re-extracts on a transform-only redraw (property extraction does not run per frame)', async () => {
    // A Proxy around the real parsed store counts every property read
    // `extractPropertiesOnDemand` makes on it -- a store read only happens
    // when extraction actually runs, so this counts extraction work without
    // depending on any particular internal call shape.
    let storeReads = 0;
    const proxiedStore = new Proxy(await parseFixture(), {
      get(target, prop, receiver) {
        storeReads++;
        return Reflect.get(target, prop, receiver);
      },
    });
    useViewerStore.getState().setIfcDataStore(proxiedStore);

    const stub = installCanvasStub();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const engine = new GraphicOverrideEngine([BASE_RULE, FIRE_RULE]);
    const props = {
      drawing: EMPTY_DRAWING,
      showHiddenLines: false,
      overrideEngine: engine,
      overridesEnabled: true,
      entityColorMap: new Map(),
      useIfcMaterials: false,
      sectionAxis: 'down' as const,
    };
    try {
      act(() => {
        root.render(<Drawing2DCanvas {...props} transform={{ x: 0, y: 0, scale: 1 }} />);
      });
      assert.ok(storeReads > 0, 'expected the first draw to have extracted properties from the store');
      const afterFirstDraw = storeReads;

      // Pan: only `transform` changes. `Drawing2DCanvas`'s draw `useEffect`
      // is keyed on `transform` and reruns, but
      // `useDrawingElementPropertiesLookup`'s `useMemo` is keyed on
      // drawing/models/ifcDataStore/overrideEngine/overridesEnabled, NOT
      // `transform` -- so it must not recompute, and the store must see no
      // further reads.
      act(() => {
        root.render(<Drawing2DCanvas {...props} transform={{ x: 5, y: 5, scale: 1 }} />);
      });
      assert.equal(
        storeReads,
        afterFirstDraw,
        `expected zero additional store reads on a transform-only redraw; reads went from ${afterFirstDraw} to ${storeReads}`,
      );
    } finally {
      act(() => root.unmount());
      container.remove();
      stub.restore();
      useViewerStore.getState().setIfcDataStore(null);
    }
  });
});
