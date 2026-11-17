/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { geometryExportDialogsEn } from '../catalogues/geometry-export-dialogs.en';
import { retainedGeometryEn } from '../catalogues/retained-geometry.en';
import { checkCatalogue } from '../catalogue-problems';
import { englishMessage } from '../registry';

// #8896: these are the actual option messages consumed by GLBExportDialog.
test('#8896 GLB colour choices explain apparent SurfaceColour and distinct DiffuseColour', () => {
  const messages = geometryExportDialogsEn;
  assert.deepEqual({
    rendering: messages['geometryExport.glb.colorSourceRendering'],
    shading: messages['geometryExport.glb.colorSourceShading'],
  }, { rendering: 'Rendering (apparent colour)', shading: 'Shading (DiffuseColour)' });
  assert.equal(messages['geometryExport.glb.colorSourceRenderingHint'],
    'Uses SurfaceColour, including a numeric DiffuseColour factor. A separate DiffuseColour RGB colour does not replace SurfaceColour.');
  assert.equal(messages['geometryExport.glb.colorSourceShadingHint'],
    'Uses a separately authored, distinct DiffuseColour RGB colour; otherwise the apparent rendering colour.');
});

// Importing a catalogue supplies data, but must not register its lazy English copy.
// Each test file runs in a fresh Node process under the viewer test runner.
test('#8896 all retained messages validate before feature English registration', () => {
  for (const key of Object.keys(retainedGeometryEn) as (keyof typeof retainedGeometryEn)[]) {
    assert.equal(englishMessage(key), undefined, `${key} must remain lazy at startup`);
  }
  assert.deepEqual(checkCatalogue(retainedGeometryEn), {
    catalogue: retainedGeometryEn, problems: [],
  });
});

test('#8896 startup validator accepts translated retained messages and rejects lost parameters', () => {
  const key = 'retainedGeometry.faces.title';
  assert.equal(englishMessage(key), undefined);
  const translated = { [key]: 'Flächen für #{id}: {count}' };
  assert.deepEqual(checkCatalogue(translated), { catalogue: translated, problems: [] });
  assert.deepEqual(checkCatalogue({ [key]: 'Flächen für #{id}' }), {
    catalogue: {}, problems: [`${key}: missing placeholder {count}`],
  });
  assert.deepEqual(checkCatalogue({ [key]: 'Flächen für #{id}: {total}' }), {
    catalogue: {}, problems: [
      `${key}: unknown placeholder {total}`, `${key}: missing placeholder {count}`,
    ],
  });
  assert.deepEqual(checkCatalogue({ 'retainedGeometry.unknown': 'Unbekannt' }), {
    catalogue: {}, problems: ['retainedGeometry.unknown: not an English catalogue key'],
  });
});
