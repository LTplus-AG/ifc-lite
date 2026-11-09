/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { IfcCreator } from '../index.js';
import { StepExporter } from '@ifc-lite/export';
import { parseModel } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addWallToStore } from './wall.js';
import { extractWallSegmentsForStorey } from './extract-walls.js';

it.each([0, Math.PI / 4].flatMap(angle => [false, true].map(reopened => ({ angle, reopened }))))('measures a local-Y mesh wall perpendicular to its axis, %o (#9423 review)', async ({ angle, reopened }) => {
  const c = new IfcCreator();
  const storey = c.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  const { store } = await parseModel(new TextEncoder().encode(c.toIfc().content), { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, storey, view);
  const wall = addWallToStore(editor, anchor, { Start: [10, 20, 0], End: [10 + 5 * Math.cos(angle), 20 + 5 * Math.sin(angle), 0], Thickness: .2, Height: 3 });
  // A real closed prism whose mesh's long axis is local Y rather than local X.
  const coords = editor.addEntity('IfcCartesianPointList3D', [[[-.1,0,0],[.1,0,0],[.1,5,0],[-.1,5,0],[-.1,0,3],[.1,0,3],[.1,5,3],[-.1,5,3]]]).expressId;
  const mesh = editor.addEntity('IfcTriangulatedFaceSet', [`#${coords}`, null, true, [[1,3,2],[1,4,3],[5,6,7],[5,7,8],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,4,8],[3,8,7],[4,1,5],[4,5,8]], null]).expressId;
  const rep = editor.addEntity('IfcShapeRepresentation', [`#${anchor.bodyContextId}`, 'Body', 'Tessellation', [`#${mesh}`]]).expressId;
  const shape = editor.addEntity('IfcProductDefinitionShape', [null, null, [`#${rep}`]]).expressId;
  editor.setPositionalAttribute(wall.wallId, 6, `#${shape}`);
  const loaded = reopened ? (await parseModel(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content, { disableWorkerScan: true })).store : store;
  const result = extractWallSegmentsForStorey(loaded, storey, reopened ? undefined : view);
  expect(result.wallThicknesses[result.contributingWallIds.indexOf(wall.wallId)]).toBeCloseTo(.2, 8);
});
