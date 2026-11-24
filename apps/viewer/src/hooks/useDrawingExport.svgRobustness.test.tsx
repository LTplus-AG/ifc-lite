/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The direct SVG export wrote `NaN`/`Infinity` into `viewBox`, `width`/`height`
 * and path data for an empty or corrupt section; strict consumers (Illustrator,
 * Inkscape, CAD importers) reject or blank such a file. The PDF export already
 * refuses or skips the same inputs.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GraphicOverrideEngine, type Drawing2D } from '@ifc-lite/drawing-2d';
import useDrawingExport from './useDrawingExport.js';
import { useActivityJournal } from '@/lib/activity/activity-journal';
import { waitFor } from '@/test/render.js';
import { toast } from '@/components/ui/toast';

const base = (): Drawing2D => ({
  config: { plane: { axis: 'y', position: 0, flipped: false }, projectionDepth: 10, includeHiddenLines: true, creaseAngle: 30, scale: 50 },
  lines: [], cutPolygons: [], projectionPolygons: [],
  bounds: { min: { x: 0, y: 0 }, max: { x: 4, y: 3 } },
  stats: { cutLineCount: 0, projectionLineCount: 0, hiddenLineCount: 0, silhouetteLineCount: 0, polygonCount: 0, totalTriangles: 0, processingTimeMs: 0 },
});
const poly = (outer: { x: number; y: number }[], holes: { x: number; y: number }[][] = []): Drawing2D['cutPolygons'][number] => ({
  polygon: { outer, holes }, ifcType: 'IfcWall', entityId: 7, modelIndex: 0, isCut: true,
});
const sq = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }];
const _line = (a: { x: number; y: number }, b: { x: number; y: number }): Drawing2D['lines'][number] => ({
  line: { start: a, end: b }, category: 'cut', visibility: 'visible', entityId: 1, ifcType: 'IfcWall', modelIndex: 0, depth: 0,
});

/** Extra hook inputs a case needs (text annotations); reset by `run`. */
let extraInputs: Record<string, unknown> = {};
const BAD = '\u0001\u000B';
const cases: Record<string, (d: Drawing2D) => void> = {
  controlIfcType: (d) => { d.cutPolygons = [{ ...poly(sq), ifcType: `Ifc${BAD}Wall` }]; },
  nanEntityId: (d) => { d.cutPolygons = [{ ...poly(sq), entityId: NaN }]; },
  controlAnnotation: (d) => {
    extraInputs = {
      textAnnotations2D: [{ id: 'a', position: { x: 1, y: 1 }, text: `note${BAD}`, fontSize: 14, color: `#000${BAD}`, backgroundColor: '#fff', borderColor: '#333' }],
      cloudAnnotations2D: [{ id: 'c', points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }], color: '#e53935', label: `rev${BAD}` }],
    };
    d.cutPolygons = [poly(sq)];
  },
  emptyBounds: (d) => { d.bounds = { min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity } }; },
  pointBounds: (d) => { d.bounds = { min: { x: 2, y: 2 }, max: { x: 2, y: 2 } }; d.lines = [_line({ x: 2, y: 2 }, { x: 2, y: 2 })]; },
  nanBounds: (d) => { d.bounds = { min: { x: NaN, y: 0 }, max: { x: 4, y: 3 } }; },
  nanOuter: (d) => { d.cutPolygons = [poly([{ x: 0, y: 0 }, { x: NaN, y: 0 }, { x: 4, y: 3 }])]; },
  nanHole: (d) => { d.cutPolygons = [poly(sq, [[{ x: 1, y: NaN }, { x: 2, y: 1 }, { x: 2, y: 2 }]])]; },
};

function Harness({ fn, d, onReady }: { fn: string; d: Drawing2D; onReady: (f: () => void) => void }): null {
  const h = useDrawingExport({
    drawing: d,
    displayOptions: { showHiddenLines: true, scale: 50, showScanSection: false, scanSectionOpacity: 0, scanSectionIncludeInExport: false },
    sectionPlane: { axis: 'down', position: 50, flipped: false },
    activePresetId: null, entityColorMap: new Map(), overridesEnabled: false, overrideEngine: new GraphicOverrideEngine([]),
    measure2DResults: [], polygonArea2DResults: [], textAnnotations2D: [], cloudAnnotations2D: [],
    sheetEnabled: false, activeSheet: null, dxfUnderlays: [], ifcDataStore: null, coordinateInfo: undefined, scanSection: { points: [] },
    ...extraInputs,
  });
  onReady(h.handleExportSVG);
  return null;
}

/** The direct SVG the export handler downloads, or the error message it toasted. */
async function run(name: string): Promise<string> {
  useActivityJournal.setState({ jobs: [] });
  extraInputs = {};
  const d = base(); cases[name](d);
  const container = document.createElement('div'); document.body.appendChild(container);
  let root: Root | null = null; let fn: (() => void) | null = null; let blob: Blob | null = null;
  const orig = URL.createObjectURL;
  const origError = toast.error;
  let toasted: string | null = null;
  toast.error = (message: string) => { toasted = message; };
  URL.createObjectURL = function (o: Blob | MediaSource): string { if (o instanceof Blob && o.type === 'image/svg+xml') blob = o; return orig.call(URL, o); };
  try {
    await act(async () => { root = createRoot(container); root.render(<Harness fn={name} d={d} onReady={(f) => { fn = f; }} />); });
    await act(async () => { fn!(); });
    await waitFor(() => blob !== null || toasted !== null, 'the export finished');
    if (toasted !== null) return `ERROR ${toasted}`;
    return Buffer.from(await (blob as unknown as Blob).arrayBuffer()).toString('utf8');
  } catch (e) { return `ERROR ${e}`; } finally {
    URL.createObjectURL = orig;
    toast.error = origError;
    if (root) await act(async () => { (root as Root).unmount(); });
    container.remove();
  }
}


const NON_FINITE = /(?:NaN|Infinity|undefined)/;

describe('direct SVG export never writes a non-finite number', () => {
  it('refuses an empty section instead of writing viewBox="Infinity ..."', async () => {
    const out = await run('emptyBounds');
    assert.ok(out.startsWith('ERROR') && /bounds/.test(out), out.slice(0, 200));
  });
  it('refuses NaN bounds', async () => {
    const out = await run('nanBounds');
    assert.ok(out.startsWith('ERROR') && /bounds/.test(out), out.slice(0, 200));
  });
  it('gives a single-point drawing a positive viewBox', async () => {
    const svg = await run('pointBounds');
    const [, , w, h] = /viewBox="([^"]+)"/.exec(svg)![1].split(' ').map(Number);
    assert.ok(w > 0 && h > 0, `viewBox ${w} x ${h}`);
    assert.match(svg, /width="[1-9][\d.]*mm"/);
  });
  it('leaves a ring with a NaN vertex out of the path data', async () => {
    const svg = await run('nanOuter');
    assert.doesNotMatch(svg, NON_FINITE);
    assert.ok(!svg.includes('data-entity-id="7"'), 'the unusable polygon is skipped');
  });
  it('skips only the NaN hole; the wall stays filled', async () => {
    const svg = await run('nanHole');
    assert.doesNotMatch(svg, NON_FINITE);
    assert.match(svg, /<path d="M 0\.0000 0\.0000 L 4\.0000 0\.0000 L 4\.0000 3\.0000 L 0\.0000 3\.0000 Z"/);
  });
  it('writes well-formed XML for a control character in ifcType (xmllint)', async () => {
    const svg = await run('controlIfcType');
    const r = spawnSync('xmllint', ['--noout', '-'], { input: svg, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(svg, /data-ifc-type="Ifc\uFFFD\uFFFDWall"/);
  });
  it('writes well-formed XML for control characters in annotation text, colour and cloud label (xmllint)', async () => {
    const svg = await run('controlAnnotation');
    const r = spawnSync('xmllint', ['--noout', '-'], { input: svg, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
  it('omits data-entity-id for a non-finite id', async () => {
    const svg = await run('nanEntityId');
    assert.doesNotMatch(svg, /data-entity-id="NaN"/);
    assert.match(svg, /data-ifc-type="IfcWall"/);
  });
});
