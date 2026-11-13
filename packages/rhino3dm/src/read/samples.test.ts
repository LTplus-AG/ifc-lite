/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { readRhino3dm, RhinoReadError } from '../index.js';
import { drawnTriangles } from '../../test-support/craft.js';

/**
 * Files saved by Rhino 8 itself, from the MIT-licensed mcneel/rhino3dm test
 * models at tag 8.35.0. The fixture manifest pins them to that commit, so they
 * are fetched from McNeel's repository and never re-hosted.
 */
const samples = fileURLToPath(new URL('../../../../tests/models/rhino/mcneel-rhino3dm/', import.meta.url));
const sample = (name: string) => new Uint8Array(readFileSync(samples + name));
const absent = !['blocks', 'file3dm_stuff', 'mesh', 'object_UserStrings', 'subd_creases'].every(name => existsSync(`${samples}${name}.3dm`));

describe.skipIf(absent)(`Rhino-authored samples${absent ? ' (skipped: run pnpm fixtures)' : ''}`, () => {
  test('mesh.3dm: a Rhino 8 mesh in millimetres on the Default layer', async () => {
    const result = await readRhino3dm(sample('mesh.3dm'));
    expect(result.document).toMatchObject({ archiveVersion: 80, application: 'Rhinoceros 8', unitSystem: 'Millimeters', provenance: 'rhino', earthAnchor: null });
    expect(result.entities).toMatchObject([{ name: 'Mesh', geometryType: 'Mesh', ifcClass: 'IfcBuildingElementProxy', hidden: false }]);
    // 420 vertices and 276 triangular faces in the file.
    expect(result.meshes[0].positions).toHaveLength(420 * 3);
    expect(drawnTriangles(result)).toBe(276);
    expect(result.layers.map(l => l.fullPath)).toEqual(['Default']);
    expect([result.skipped, result.warnings]).toEqual([{}, []]);
  });

  test('file3dm_stuff.3dm: every object type is drawn or counted', async () => {
    const result = await readRhino3dm(sample('file3dm_stuff.3dm'));
    expect(result.entities.map(e => [e.geometryType, result.layers[e.layer].name])).toEqual([
      ['PolylineCurve', 'Curves'], ['ArcCurve', 'Curves'], ['NurbsCurve', 'Curves'], ['PointCloud', 'Points'], ['Brep', 'Points'],
    ]);
    // Only one of the file's Breps and Extrusions carries a render mesh; its two block instances draw nothing.
    expect(result.skipped).toEqual({ 'Extrusion:no-render-mesh': 3, 'Brep:no-render-mesh': 4, Point: 8 });
    expect([result.meshes.length, result.curves.length, result.pointClouds.length, result.instances.length]).toEqual([1, 3, 1, 0]);
    expect(result.layers.map(l => l.name)).toEqual(['Default', 'Extrusions', 'Curves', 'Breps', 'Points', 'Layer 05']);
    // Colour by layer: the Points layer is green (0, 127, 0).
    expect(result.meshes[0]).toMatchObject({ entity: 4, color: [0, 127 / 255, 0, 1] });
    expect(result.pointClouds[0]).toMatchObject({ entity: 3, colors: null });
    expect(result.pointClouds[0].positions).toHaveLength(8 * 3);
    expect(result.document.strings).toHaveLength(1);
  });

  test('blocks.3dm: an instance draws the one member that can be drawn', async () => {
    const result = await readRhino3dm(sample('blocks.3dm'));
    expect(result.entities.map(e => e.geometryType)).toEqual(['InstanceReference', 'InstanceReference']);
    expect(result.curves.map(c => c.entity)).toEqual([0, 1]);
    expect(result.skipped).toEqual({ 'Brep:no-render-mesh': 1, 'Extrusion:no-render-mesh': 2 });
  });

  test.each([[0, 12], [1, 48], [2, 192], [3, 768]] as const)('subd_creases.3dm at level %i is %i triangles', async (subdLevel, triangles) => {
    const result = await readRhino3dm(sample('subd_creases.3dm'), { subdLevel });
    expect(drawnTriangles(result)).toBe(triangles);
    expect(result.entities[0].geometryType).toBe('SubD');
    // The file gives the object layer index -1.
    expect(result.entities[0].layer).toBe(0);
    expect(result.warnings).toEqual([`1 SubD object shown as the control net at subdivision level ${subdLevel}, an approximation of the limit surface.`]);
  });

  test('the default SubD level is 2', async () => {
    expect(drawnTriangles(await readRhino3dm(sample('subd_creases.3dm')))).toBe(192);
  });

  test('object_UserStrings.3dm: an extrusion saved without a render mesh is refused', async () => {
    const error = await readRhino3dm(sample('object_UserStrings.3dm')).catch(e => e);
    expect(error).toBeInstanceOf(RhinoReadError);
    expect(error.code).toBe('no-renderable-geometry');
    expect(error.message).toBe('Nothing in this file can be drawn (skipped: 1 Extrusion:no-render-mesh). Surfaces need the render meshes Rhino stores with the file: open it in Rhino, switch to a shaded view and save without "Save Small".');
  });
});
