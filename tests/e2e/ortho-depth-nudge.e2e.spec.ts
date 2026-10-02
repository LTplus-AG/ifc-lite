/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Orthographic views keep hidden surfaces hidden on large sites (#6729).
 *
 * The per-entity anti z-fighting depth nudge used to scale clip z, which in
 * orthographic depth (linear over the whole scene range) shifted a fragment by
 * up to `255e-6 * z * range`: tens of centimetres on a kilometre site, so a rod
 * running through a beam was drawn over the beam's face.
 *
 * Forty red rods (r = 5 cm) each run vertically through a blue 40 cm beam
 * block, 15 cm behind its front face. A 1 km slab behind them sets the depth
 * range. Viewed horizontally in orthographic projection, each beam's front face
 * fills one band of screen rows, and no rod pixel may appear inside it. On
 * `main` before the fix several rods show through, the ones whose hash beats
 * their beam's by enough.
 */

import { expect, test } from '@playwright/test';
import { decodePng, rendererColorFrame } from './federation-control-triplet.rendering';

/** Four stacked rows of ten beam/rod pairs, so all forty fit the 512 px capture. */
const ROWS = 4;
const PER_ROW = 10;
const PAIRS = ROWS * PER_ROW;
const SPACING = 0.6;
const ROW_PITCH = 1.75;
const BEAM = 0.4;
const ROD_RADIUS = 0.05;
/** Viewer-space height of the rows' centre, where the camera looks. */
const CENTRE_Y = BEAM / 2 + ((ROWS - 1) / 2) * ROW_PITCH;
/** Orthographic half-height: every row fits, each beam band a few dozen rows tall. */
const ORTHO_SIZE = 3.6;

/** A minimal IFC4 file: the slab, then each beam and the rod through it. */
function modelIfc(): string {
  const lines: string[] = [];
  const add = (entity: string): number => { lines.push(`#${lines.length + 1}=${entity};`); return lines.length; };
  const real = (value: number): string => (Number.isInteger(value) ? `${value}.` : `${value}`);
  const origin = add('IFCCARTESIANPOINT((0.,0.,0.))');
  const up = add('IFCDIRECTION((0.,0.,1.))');
  const east = add('IFCDIRECTION((1.,0.,0.))');
  const axes = add(`IFCAXIS2PLACEMENT3D(#${origin},#${up},#${east})`);
  const context = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#${axes},$)`);
  const metre = add('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)');
  const units = add(`IFCUNITASSIGNMENT((#${metre}))`);
  const project = add(`IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'Project',$,$,$,$,(#${context}),#${units})`);
  const sitePlacement = add(`IFCLOCALPLACEMENT($,#${axes})`);
  const site = add(`IFCSITE('1YvctVUKr0kugbFTf53O9L',$,'Site',$,$,#${sitePlacement},$,$,.ELEMENT.,$,$,$,$,$)`);
  add(`IFCRELAGGREGATES('2YvctVUKr0kugbFTf53O9L',$,$,$,#${project},(#${site}))`);
  const profileOrigin = add(`IFCAXIS2PLACEMENT2D(#${add('IFCCARTESIANPOINT((0.,0.))')},$)`);
  const colour = (r: number, g: number, b: number): number =>
    add(`IFCSURFACESTYLE($,.BOTH.,(#${add(`IFCSURFACESTYLESHADING(#${add(`IFCCOLOURRGB($,${r},${g},${b})`)},0.)`)}))`);
  const red = colour(0.9, 0.1, 0.1), blue = colour(0.1, 0.2, 0.9), grey = colour(0.6, 0.6, 0.6);
  const elements: number[] = [];
  const element = (type: string, predefined: string, x: number, y: number, z: number, profile: number, depth: number, style: number): void => {
    const position = add(`IFCAXIS2PLACEMENT3D(#${add(`IFCCARTESIANPOINT((${real(x)},${real(y)},${real(z)}))`)},#${up},#${east})`);
    const solid = add(`IFCEXTRUDEDAREASOLID(#${profile},#${axes},#${up},${real(depth)})`);
    add(`IFCSTYLEDITEM(#${solid},(#${style}),$)`);
    const body = add(`IFCSHAPEREPRESENTATION(#${context},'Body','SweptSolid',(#${solid}))`);
    const guid = `3YvctVUKr0kugbFTf5${String(elements.length).padStart(4, '0')}`;
    elements.push(add(`${type}('${guid}',$,'${type}',$,$,#${add(`IFCLOCALPLACEMENT(#${sitePlacement},#${position})`)},`
      + `#${add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${body}))`)},$,${predefined})`));
  };
  // The slab spans y -10..990, so the pairs at y = 0 sit at the near end of the depth range.
  element('IFCSLAB', '.BASESLAB.', 0, 490, -1.3, add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${profileOrigin},1000.,1000.)`), 0.3, grey);
  const beamProfile = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${profileOrigin},${BEAM},${BEAM})`);
  const rodProfile = add(`IFCCIRCLEPROFILEDEF(.AREA.,$,#${profileOrigin},${ROD_RADIUS})`);
  for (let row = 0; row < ROWS; row++) for (let k = 0; k < PER_ROW; k++) {
    const x = Math.round((k - (PER_ROW - 1) / 2) * SPACING * 100) / 100, z = row * ROW_PITCH;
    element('IFCBEAM', '.BEAM.', x, 0, z, beamProfile, BEAM, blue);
    element('IFCMEMBER', '.STUD.', x, 0, z - 0.6, rodProfile, 1.6, red);
  }
  add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('4YvctVUKr0kugbFTf53O9L',$,$,$,(${elements.map(id => `#${id}`).join(',')}),#${site})`);
  return ['ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    "FILE_NAME('ortho-depth-nudge.ifc','2026-10-02T00:00:00',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;',
    'DATA;', ...lines, 'ENDSEC;', 'END-ISO-10303-21;'].join('\n');
}

test('orthographic: rods inside beams stay hidden on a 1 km site (#6729)', async ({ page }, info) => {
  await page.goto('/');
  await page.locator('#file-input-open').setInputFiles({
    name: 'ortho-depth-nudge.ifc', mimeType: 'application/octet-stream', buffer: Buffer.from(modelIfc()),
  });
  await page.waitForFunction(() => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    return !!state && !state.loading && state.models.size === 1 && !!state.cameraCallbacks.getViewpoint?.()
      && !!globalThis.__ifc_lite_capture_color_frame__;
  }, undefined, { timeout: 180_000 });

  // Viewer space is Y-up: the beams' front faces (IFC y = -0.2) look toward +z.
  await page.evaluate(({ orthoSize, y }) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.setProjectionMode('orthographic');
    state.cameraCallbacks.applyViewpoint?.({
      position: { x: 0, y, z: 6 }, target: { x: 0, y, z: 0 }, up: { x: 0, y: 1, z: 0 },
      fov: Math.PI / 4, projectionMode: 'orthographic', orthoSize,
    }, false);
  }, { orthoSize: ORTHO_SIZE, y: CENTRE_Y });
  await page.waitForTimeout(500);

  // The capture is a central crop of the drawing buffer at native resolution.
  const bufferHeight = await page.evaluate(() => document.querySelector<HTMLCanvasElement>('canvas[data-viewport="main"]')!.height);
  const png = await rendererColorFrame(page);
  await info.attach('ortho-rods.png', { body: png, contentType: 'image/png' });
  const { width, height, rgba } = decodePng(png);
  const isRed = (i: number) => rgba[i]! > 90 && rgba[i]! > rgba[i + 1]! * 1.8 && rgba[i]! > rgba[i + 2]! * 1.8;
  const isBlue = (i: number) => rgba[i + 2]! > 90 && rgba[i + 2]! > rgba[i]! * 1.8;

  // Each row's beams span BEAM in height around their centre; the screen rows
  // they cover, less a few for anti-aliased edges.
  const pxPerMetre = bufferHeight / 2 / ORTHO_SIZE;
  const bands = Array.from({ length: ROWS }, (_, row) => {
    const centre = height / 2 - (row * ROW_PITCH + BEAM / 2 - CENTRE_Y) * pxPerMetre;
    return [Math.ceil(centre - (BEAM / 2) * pxPerMetre) + 3, Math.floor(centre + (BEAM / 2) * pxPerMetre) - 3] as const;
  });
  for (const [top, bottom] of bands) expect(bottom - top, 'each beam band is many rows tall').toBeGreaterThan(15);
  let rodInBand = 0, beamInBand = 0, rodOutside = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const inBand = bands.some(([top, bottom]) => y >= top && y <= bottom);
    if (isRed(i)) { if (inBand) rodInBand++; else rodOutside++; }
    else if (inBand && isBlue(i)) beamInBand++;
  }
  // Positive controls: the beams fill the band and the rods show above and below it.
  expect(beamInBand, 'beam faces are drawn in the band').toBeGreaterThan(PAIRS * 20);
  expect(rodOutside, 'rods are drawn above and below the beams').toBeGreaterThan(PAIRS * 20);
  expect(rodInBand, 'no rod pixel shows through a beam face').toBe(0);
});
