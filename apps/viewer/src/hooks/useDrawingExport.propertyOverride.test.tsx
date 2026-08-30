/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The built-in "Fire Safety" preset (`packages/drawing-2d/src/graphic-overrides/presets.ts`)
 * colors walls by their `FireRating` property (`propertyCriterion('FireRating', ...)`),
 * and is directly selectable in `DrawingSettingsPanel.tsx`'s "Style Presets" list
 * (`graphicOverridePresets.map(...)`, backed by `BUILT_IN_PRESETS`). #3520 removed the
 * sibling `material`/`layer` criteria because no construction site ever populated
 * `ElementData.materials`/`.layers`; it explicitly scoped `properties` out.
 *
 * Every `ElementData` construction site in `useDrawingExport.ts` built only
 * `{ expressId, ifcType }`, same as the sites #3520 fixed — so a `property`
 * criterion could never match, and the Fire Safety preset silently painted every
 * wall with its base (non-matching) style, no matter how it was fire-rated. This
 * pins the fix: `generateExportSVG`'s two render loops now resolve `properties`
 * from the real parsed model (`ifcDataStore`) before calling `applyOverrides`.
 *
 * Control: a plain `ifcType` criterion (`base` rule below) must match regardless
 * of the fix, isolating the assertion to the property path specifically.
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
  propertyCriterion,
  andCriteria,
  type Drawing2D,
  type GraphicOverrideRule,
} from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import useDrawingExport from './useDrawingExport.js';

// ─── Fixture: one fire-rated wall, parsed the way production data arrives ──

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

/** IfcWall #1, FireRating (IfcInteger, 120 = 2-hour rating) via Pset_WallCommon. */
const WALL_BODY = [
  "#1=IFCWALL('0aaaaaaaaaaaaaaaaaaaaa',$,'Wall A',$,$,$,$,$,.STANDARD.);",
  "#2=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCINTEGER(120),$);",
  "#3=IFCPROPERTYSET('0bbbbbbbbbbbbbbbbbbbbb',$,'Pset_WallCommon',$,(#2));",
  "#4=IFCRELDEFINESBYPROPERTIES('0ccccccccccccccccccccc',$,$,$,(#1),#3);",
].join('\n');

async function parseWall(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ifc4(WALL_BODY));
  // disableWorkerScan keeps the scan in-process (no Worker under node:test).
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

function buildDrawing(): Drawing2D {
  const outer = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 1 },
    { x: 0, y: 1 },
  ];
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
        polygon: { outer, holes: [] },
        entityId: 1,
        ifcType: 'IfcWall',
        modelIndex: 0,
        isCut: true,
      },
    ],
    projectionPolygons: [],
    bounds: { min: { x: 0, y: 0 }, max: { x: 4, y: 1 } },
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
}

/** Mirrors the Fire Safety preset's "Fire Rated 2hr+" rule shape: an `ifcType`
 *  control rule (low priority, always matches) plus a higher-priority rule that
 *  ALSO requires the `FireRating` property — so a broken property path falls
 *  back to the control color, and a working one wins with the fire color. */
function buildRules(): GraphicOverrideRule[] {
  return [
    {
      id: 'base',
      name: 'Walls - base',
      enabled: true,
      priority: 100,
      criteria: ifcTypeCriterion(['IfcWall']),
      style: { fillColor: '#BASEBASE' },
    },
    {
      id: 'fire',
      name: 'Fire Rated 2hr+',
      enabled: true,
      priority: 200,
      criteria: andCriteria(
        ifcTypeCriterion(['IfcWall']),
        propertyCriterion('FireRating', 'greaterOrEqual', 120),
      ),
      style: { fillColor: '#FIREFIRE' },
    },
  ];
}

// ─── Harness ────────────────────────────────────────────────────────────

interface HarnessProps {
  ifcDataStore: IfcDataStore | null;
  onReady: (fn: () => void) => void;
}

function Harness({ ifcDataStore, onReady }: HarnessProps): null {
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
    overrideEngine: new GraphicOverrideEngine(buildRules()),
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
async function exportSvg(ifcDataStore: IfcDataStore | null): Promise<string> {
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

describe('useDrawingExport — property-criterion overrides reach the real model', () => {
  it('CONTROL: an ifcType-only rule matches regardless of the property path', async () => {
    useViewerStore.setState({ models: new Map() });
    const svg = await exportSvg(null); // no data store at all — property lookup impossible
    assert.ok(
      svg.includes('#BASEBASE'),
      'the base ifcType rule must apply even with no data store, proving the harness and engine work',
    );
  });

  it('matches a FireRating property criterion against the real parsed model', async () => {
    useViewerStore.setState({ models: new Map() });
    const store = await parseWall();
    const svg = await exportSvg(store);
    assert.ok(
      svg.includes('#FIREFIRE'),
      'FireRating=120 (>= the 120 threshold) must win over the base rule once `ElementData.properties` is populated from the real model',
    );
    assert.ok(
      !svg.includes('#BASEBASE'),
      'the higher-priority fire rule should have fully overridden the base fill, not merely coexisted with it',
    );
  });
});
