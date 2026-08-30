/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every `ElementData` construction site in `useDrawingExport.ts` built only
 * `{ expressId, ifcType }`, so the rule engine's `property`/`propertySet`
 * criteria could never match — the same gap #3520 found (and removed) for the
 * sibling `ElementData.materials`/`.layers`. This pins the wiring fix.
 *
 * The rules under test are the SHIPPED `FIRE_SAFETY_PRESET` /
 * `STRUCTURAL_PRESET` objects, not hand-written look-alikes, so the test cannot
 * quietly disagree with what a user actually selects in the drawing settings
 * panel's Style Presets list.
 *
 * The fixture writes each property with its IFC4-declared type:
 * `Pset_WallCommon.FireRating` and `Pset_DoorCommon.FireRating` are `IfcLabel`
 * (`IFCLABEL('REI 120')`, `IFCLABEL('EI30')` — the encoding this repo's own
 * fixtures use: `apps/server/src/services/data_model/tests.rs:161`,
 * `apps/viewer/src/lib/lists/server-type-parity.test.ts:54`,
 * `packages/mcp/src/backend-query-duplicate-pset-filter.test.ts:52`), and
 * `Pset_WallCommon.LoadBearing` is `IfcBoolean`. Encoding `FireRating` as
 * `IFCINTEGER` instead would make the preset's `greaterOrEqual` wall rules pass
 * here while staying dead on every conformant file — a fixture that agrees with
 * the fix only because it disagrees with the schema.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import {
  GraphicOverrideEngine,
  ifcTypeCriterion,
  FIRE_SAFETY_PRESET,
  STRUCTURAL_PRESET,
  type Drawing2D,
  type GraphicOverrideRule,
} from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import useDrawingExport from './useDrawingExport.js';

// ─── Fixture: one fire-rated load-bearing wall + one fire door ─────────────

const WALL_ID = 1;
const DOOR_ID = 6;

/** A syntactically valid 22-character IFC GlobalId. */
function guid(letter: string): string {
  return `0${letter.repeat(21)}`;
}

function ifc4(body: string): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    body,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

const BODY = [
  `#${WALL_ID}=IFCWALL('${guid('a')}',$,'Wall A',$,$,$,$,$,.STANDARD.);`,
  `#2=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI 120'),$);`,
  `#3=IFCPROPERTYSINGLEVALUE('LoadBearing',$,IFCBOOLEAN(.T.),$);`,
  `#4=IFCPROPERTYSET('${guid('b')}',$,'Pset_WallCommon',$,(#2,#3));`,
  `#5=IFCRELDEFINESBYPROPERTIES('${guid('c')}',$,$,$,(#${WALL_ID}),#4);`,
  `#${DOOR_ID}=IFCDOOR('${guid('d')}',$,'Door A',$,$,$,$,$,$,$,$,$,$);`,
  `#7=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('EI30'),$);`,
  `#8=IFCPROPERTYSET('${guid('e')}',$,'Pset_DoorCommon',$,(#7));`,
  `#9=IFCRELDEFINESBYPROPERTIES('${guid('f')}',$,$,$,(#${DOOR_ID}),#8);`,
].join('\n');

async function parseFixture(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ifc4(BODY));
  // disableWorkerScan keeps the scan in-process (no Worker under node:test).
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

function box(x0: number, x1: number): { x: number; y: number }[] {
  return [
    { x: x0, y: 0 },
    { x: x1, y: 0 },
    { x: x1, y: 1 },
    { x: x0, y: 1 },
  ];
}

function buildDrawing(): Drawing2D {
  return {
    config: {
      plane: { axis: 'z', position: 0, flipped: false },
      projectionDepth: 10,
      includeHiddenLines: true,
      creaseAngle: 30,
      scale: 50,
    },
    lines: [],
    cutPolygons: [
      {
        polygon: { outer: box(0, 4), holes: [] },
        entityId: WALL_ID,
        ifcType: 'IfcWall',
        modelIndex: 0,
        isCut: true,
      },
      {
        polygon: { outer: box(5, 6), holes: [] },
        entityId: DOOR_ID,
        ifcType: 'IfcDoor',
        modelIndex: 0,
        isCut: true,
      },
    ],
    projectionPolygons: [],
    bounds: { min: { x: 0, y: 0 }, max: { x: 6, y: 1 } },
    stats: {
      cutLineCount: 0,
      projectionLineCount: 0,
      hiddenLineCount: 0,
      silhouetteLineCount: 0,
      polygonCount: 2,
      totalTriangles: 0,
      processingTimeMs: 0,
    },
  };
}

// ─── SVG readback ───────────────────────────────────────────────────────────

/** The `<g id="...">` block's inner markup. */
function group(svg: string, id: string): string {
  const start = svg.indexOf(`<g id="${id}">`);
  assert.ok(start >= 0, `SVG has no <g id="${id}"> group`);
  const end = svg.indexOf('</g>', start);
  return svg.slice(start, end);
}

/** The `fill` the export resolved for one entity's cut polygon. */
function fillOf(svg: string, entityId: number): string {
  const m = new RegExp(`fill="([^"]*)"[^>]*data-entity-id="${entityId}"`).exec(
    group(svg, 'polygon-fills'),
  );
  assert.ok(m, `no fill path for entity ${entityId}`);
  return m[1];
}

/** The `stroke` the export resolved for one entity's cut-polygon outline. */
function strokeOf(svg: string, entityId: number): string {
  const m = new RegExp(`stroke="([^"]*)"[^>]*data-entity-id="${entityId}"`).exec(
    group(svg, 'polygon-outlines'),
  );
  assert.ok(m, `no outline path for entity ${entityId}`);
  return m[1];
}

// ─── Harness ────────────────────────────────────────────────────────────────

interface HarnessProps {
  ifcDataStore: IfcDataStore | null;
  rules: GraphicOverrideRule[];
  onReady: (fn: () => void) => void;
}

function Harness({ ifcDataStore, rules, onReady }: HarnessProps): null {
  const { handleExportSVG } = useDrawingExport({
    drawing: buildDrawing(),
    displayOptions: {
      showHiddenLines: true,
      scale: 50,
      showScanSection: false,
      scanSectionOpacity: 0,
      scanSectionIncludeInExport: false,
    },
    sectionPlane: { axis: 'down', position: 0, flipped: false },
    activePresetId: null,
    entityColorMap: new Map(),
    overridesEnabled: true,
    overrideEngine: new GraphicOverrideEngine(rules),
    measure2DResults: [],
    polygonArea2DResults: [],
    textAnnotations2D: [],
    cloudAnnotations2D: [],
    sheetEnabled: false,
    activeSheet: null,
    dxfUnderlays: [],
    ifcDataStore,
    coordinateInfo: undefined,
    scanSection: { points: [] },
  });
  onReady(handleExportSVG);
  return null;
}

/** Runs the real `handleExportSVG` and returns the SVG text it produced, by
 *  intercepting the `Blob` `downloadFile` hands to `URL.createObjectURL` — the
 *  same technique `useDrawingExport.pdfVectorPaths.test.tsx` uses for the PDF
 *  path, applied to the plain-text SVG blob here. */
async function exportSvg(
  ifcDataStore: IfcDataStore | null,
  rules: GraphicOverrideRule[],
): Promise<string> {
  useViewerStore.setState({ models: new Map() });
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  let exportFn: (() => void) | null = null;

  const originalCreate = URL.createObjectURL;
  let resolveSvg!: (blob: Blob) => void;
  const svgBlob = new Promise<Blob>((resolve) => {
    resolveSvg = resolve;
  });
  URL.createObjectURL = function (obj: Blob | MediaSource): string {
    if (obj instanceof Blob && obj.type === 'image/svg+xml') resolveSvg(obj);
    return originalCreate.call(URL, obj);
  };

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <Harness
          ifcDataStore={ifcDataStore}
          rules={rules}
          onReady={(fn) => {
            exportFn = fn;
          }}
        />,
      );
    });
    let blob: Blob | null = null;
    await act(async () => {
      exportFn!();
      blob = await svgBlob;
    });
    return await (blob as unknown as Blob).text();
  } finally {
    URL.createObjectURL = originalCreate;
    if (root) await act(async () => { (root as Root).unmount(); });
    container.remove();
  }
}

/** The engine's own `DEFAULT_STYLE` fill, i.e. "no rule matched". */
const UNMATCHED_FILL = '#CCCCCC';

describe('useDrawingExport — property criteria reach the real model', () => {
  it('CONTROL: an ifcType-only rule matches with no data store at all', async () => {
    const svg = await exportSvg(null, [
      {
        id: 'base',
        name: 'Walls - base',
        enabled: true,
        priority: 100,
        criteria: ifcTypeCriterion(['IfcWall']),
        style: { fillColor: '#BASEBASE' },
      },
    ]);
    assert.equal(
      fillOf(svg, WALL_ID),
      '#BASEBASE',
      'the harness and engine must resolve a non-property rule even with no store, isolating the rest of this file to the property path',
    );
  });

  it("Structural Highlight's LoadBearing rule matches the real parsed model", async () => {
    const svg = await exportSvg(await parseFixture(), STRUCTURAL_PRESET.rules);
    assert.equal(
      fillOf(svg, WALL_ID),
      '#BBDEFB',
      "Pset_WallCommon.LoadBearing = IFCBOOLEAN(.T.) must satisfy the preset's `LoadBearing equals true` criterion",
    );
  });

  it("Fire Safety's fire-door rule matches, but its numeric wall rules still cannot", async () => {
    const svg = await exportSvg(await parseFixture(), FIRE_SAFETY_PRESET.rules);

    assert.equal(
      strokeOf(svg, DOOR_ID),
      '#C62828',
      "the 'Fire Doors' rule (`FireRating exists`) must match Pset_DoorCommon.FireRating = IFCLABEL('EI30')",
    );

    // KNOWN LIMITATION, deliberately pinned — see the changeset. The preset's
    // three wall rules compare `FireRating` numerically (`greaterOrEqual` 120 /
    // 60 / 30), and the rule engine's numeric operators return false unless
    // BOTH sides are already numbers (`rule-engine.ts` `evaluateOperator`). A
    // schema-conformant `IfcLabel` FireRating ('REI 120', 'EI90', a bare '120')
    // is a string, so no threshold matches and the wall falls through unstyled.
    // Wiring `properties` through — what this PR does — is necessary but not
    // sufficient for those three; making them work is a change to the preset's
    // own criteria, tracked separately. Delete this assertion when that lands.
    assert.equal(
      fillOf(svg, WALL_ID),
      UNMATCHED_FILL,
      "if a numeric FireRating threshold now matches IFCLABEL('REI 120'), the preset was fixed and the changeset's limitation note is stale",
    );
  });
});
