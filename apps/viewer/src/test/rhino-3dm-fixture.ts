/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One small `.3dm`, written through rhino3dm itself, for the Rhino import
 * adapter tests: a known coordinate in millimetres, Attribute User Text the
 * reader sorts into property sets, and two colour sources. Written rather
 * than downloaded so the coordinate and the user text are known exactly;
 * the Rhino-authored fixtures cover what a real file looks like.
 *
 * `packages/rhino3dm/test-support/craft.ts` is the declarative builder for the
 * same job and would be about ten lines here. It is not reused because it sits
 * outside that package's `exports` and imports its `src/` directly, so reaching
 * it means a new published subpath or a second copy of the package's runtime.
 * Worth doing when a third caller wants it.
 */

import rhino3dm from 'rhino3dm';

/** The GlobalId the crafted wall states, a real IFC GUID from the FZK model. */
export const CRAFTED_GLOBAL_ID = '2XPyKWY018sA1ygZKgQPtU';
/** First vertex of the crafted wall, in the file's millimetres. */
export const CRAFTED_VERTEX_MM: readonly [number, number, number] = [1000, 2000, 3000];
/** The same point in the viewer's Y-up metres: `x, z, -y` of `[1, 2, 3]`. */
export const CRAFTED_VERTEX_VIEWER: readonly [number, number, number] = [1, 3, -2];

/**
 * A wall with user text and its own blue colour, plus a proxy that takes its
 * red layer's colour. Both are axis-aligned triangles, so a colour or
 * coordinate assertion reads one vertex.
 */
export async function craftRhino3dm(): Promise<Uint8Array> {
  const rhino = await rhino3dm();
  const file = new rhino.File3dm();
  file.settings().modelUnitSystem = rhino.UnitSystem.Millimeters;

  const layer = new rhino.Layer();
  layer.name = 'Walls';
  layer.color = { r: 255, g: 0, b: 0, a: 255 };
  const layerIndex = file.layers().add(layer);

  const triangle = (origin: readonly [number, number, number]) => {
    const mesh = new rhino.Mesh();
    const vertices = mesh.vertices();
    vertices.addPoint3d(origin[0], origin[1], origin[2]);
    vertices.addPoint3d(origin[0] + 100, origin[1], origin[2]);
    vertices.addPoint3d(origin[0] + 100, origin[1] + 100, origin[2]);
    mesh.faces().addTriFace(0, 1, 2);
    return mesh;
  };

  const wall = new rhino.ObjectAttributes();
  wall.layerIndex = layerIndex;
  wall.objectColor = { r: 0, g: 0, b: 255, a: 255 };
  wall.colorSource = rhino.ObjectColorSource.ColorFromObject;
  for (const [key, value] of [
    ['IFC::GlobalId', CRAFTED_GLOBAL_ID],
    ['IFC::Class', 'IfcWall'],
    ['IFC::Name', 'South wall'],
    ['IFC::Description', 'Load bearing'],
    ['Pset_WallCommon::IsExternal', 'TRUE'],
    ['Comment', 'left as written'],
  ]) wall.setUserString(key, value);
  file.objects().addMesh(triangle(CRAFTED_VERTEX_MM), wall);

  const byLayer = new rhino.ObjectAttributes();
  byLayer.layerIndex = layerIndex;
  byLayer.name = 'Bracket';
  byLayer.colorSource = rhino.ObjectColorSource.ColorFromLayer;
  file.objects().addMesh(triangle([0, 0, 0]), byLayer);

  return file.toByteArray();
}
