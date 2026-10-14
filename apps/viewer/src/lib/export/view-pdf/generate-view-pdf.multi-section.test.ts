/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The PDF of a view that has SEVERAL cutting planes on (#7545).
 *
 * The screen shows what every enabled plane keeps; the sheet is the view, so it
 * must be cut by all of them, and a plane's heavy cut line must not run on into
 * a region another plane removed. A 4 x 3 x 2 m box viewed along -Z at 1:100:
 * the page width/height read the kept extent directly (10 mm per metre, plus
 * 20 mm of margin), and the rim's printed length reads the trimming.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { generateViewPdf, type ViewCameraSnapshot, type ViewPdfDeps, type ViewPdfDocument } from './generate-view-pdf.js';
import type { ViewSectionResolveInput } from './view-section-plane.js';

const BOX = { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 3, z: 2 } };

function boxMesh(): MeshData {
  const positions: number[] = [];
  for (const x of [0, 4]) for (const y of [0, 3]) for (const z of [0, 2]) positions.push(x, y, z);
  const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  const indices: number[] = [];
  for (const [a, b, c, d] of quads) indices.push(a, b, c, a, c, d);
  return {
    expressId: 42, ifcType: 'IfcWall', modelIndex: 0, positions: new Float32Array(positions),
    normals: new Float32Array(positions.length), indices: new Uint32Array(indices), color: [1, 1, 1, 1],
  };
}

const VIEW = {
  meshes: [boxMesh()], instancedMeshes: [], hiddenEntities: null, isolatedEntities: null, computedIsolatedIds: null,
  typeVisibility: { spaces: true, spatialZones: true, openings: true, virtualElements: true, site: true, ifcAnnotations: true },
  modelVisibility: null,
};

const CAMERA: ViewCameraSnapshot = {
  position: { x: 2, y: 1.5, z: 12 }, target: { x: 2, y: 1.5, z: 1 }, up: { x: 0, y: 1, z: 0 }, projectionMode: 'orthographic',
};

const cut = (axis: 'side' | 'down', position: number, flipped: boolean): ViewSectionResolveInput => ({
  plane: { axis, position, flipped }, sceneBounds: BOX, uiRange: null,
});

/** x >= 1 (flipped quarter), x <= 3 (three quarters), y <= 1.5 (half of the height). */
const FROM_X1 = cut('side', 25, true);
const TO_X3 = cut('side', 75, false);
const BELOW_Y15 = cut('down', 50, false);

interface Sheet { widthMm: number; heightMm: number; heavy: { x1: number; y1: number; x2: number; y2: number }[] }

async function sheet(section: ViewSectionResolveInput | null, extraSections: ViewSectionResolveInput[]): Promise<Sheet> {
  const heavy: Sheet['heavy'] = [];
  let width = 0;
  const deps: ViewPdfDeps = {
    buildRaster: async () => ({ raster: null, fit: { widthPx: 0, heightPx: 0, effectiveDpi: 150, capped: false } }),
    encodePng: async () => new Uint8Array(),
    createDocument: async () => {
      const doc: ViewPdfDocument = {
        setDrawColor: () => {}, setFillColor: () => {}, setTextColor: () => {}, setLineCap: () => {},
        setLineWidth: (w) => { width = w; }, setLineDashPattern: () => {}, setFontSize: () => {},
        line: (x1, y1, x2, y2) => { if (Math.abs(width - 0.5) < 1e-6) heavy.push({ x1, y1, x2, y2 }); },
        rect: () => {}, text: () => {}, addImage: () => {},
        output: () => new Blob([new Uint8Array([37, 80, 68, 70])], { type: 'application/pdf' }),
      };
      return doc;
    },
    download: () => {},
  };
  const result = await generateViewPdf(
    { view: VIEW, camera: CAMERA, section, extraSections, scaleFactor: 100, includeScaleStamp: false, renderMode: 'lines' },
    deps,
  );
  return { widthMm: result.page.widthMm, heightMm: result.page.heightMm, heavy };
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;

describe('a PDF cut by several planes (#7545)', () => {
  it('keeps what ALL the planes keep, whichever is "active"', async () => {
    const one = await sheet(FROM_X1, []);
    assert.ok(near(one.widthMm, 50), `x >= 1 alone is 3 m: ${one.widthMm}`);

    const both = await sheet(FROM_X1, [TO_X3]);
    assert.ok(near(both.widthMm, 40), `x in [1, 3] is 2 m: ${both.widthMm}`);
    assert.ok(near(both.heightMm, 50), 'the planes cut along X only, so the height is untouched');

    const swapped = await sheet(TO_X3, [FROM_X1]);
    assert.ok(near(swapped.widthMm, both.widthMm), 'which plane is active does not change the sheet');
  });

  it('prints a sheet for planes that are all inactive', async () => {
    const result = await sheet(null, [FROM_X1, BELOW_Y15]);
    assert.ok(near(result.widthMm, 50), `x >= 1: ${result.widthMm}`);
    assert.ok(near(result.heightMm, 35), `y <= 1.5: ${result.heightMm}`);
  });

  it('trims a plane\'s cut line where another plane removed the model', async () => {
    // The x = 1 face is 3 m (30 mm) of heavy line on its own; below y = 1.5 it is half.
    const rimAt = async (extra: ViewSectionResolveInput[]) => {
      const { heavy } = await sheet(FROM_X1, extra);
      const vertical = heavy.filter((s) => near(s.x1, s.x2));
      const left = Math.min(...vertical.map((s) => s.x1));
      const onPlane = vertical.filter((s) => near(s.x1, left));
      const ys = onPlane.flatMap((s) => [s.y1, s.y2]);
      return Math.max(...ys) - Math.min(...ys);
    };
    assert.ok(near(await rimAt([]), 30), 'the full-height cut line, to start from');
    assert.ok(near(await rimAt([BELOW_Y15]), 15), 'the cut line stops where the other plane cuts the model away');
  });

  it('refuses a set of planes that removes everything', async () => {
    await assert.rejects(
      sheet(cut('side', 25, false), [cut('side', 75, true)]), // x <= 1 and x >= 3
      /removes all visible geometry/,
    );
  });
});
