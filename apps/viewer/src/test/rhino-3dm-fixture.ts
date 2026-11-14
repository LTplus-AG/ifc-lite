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
import { readRhino3dm, type RhinoImport } from '@ifc-lite/rhino3dm';

import { swapRhinoImportAxes } from '@/lib/import/rhino-import-job';
import { rhinoViewerModel } from '@/hooks/ingest/rhinoViewerModel.js';
import type { ViewerModelPayload } from '@/hooks/ingest/viewerModelIngest.js';

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

/** The storey GlobalId and elevation the stamped crafted file states. */
export const CRAFTED_STOREY = { globalId: '2O2Fr$t4X7Zf8NOew3FLOH', elevation: 2.7, name: 'Level 1' };
/** The project, site and building GlobalIds of the same file. */
export const CRAFTED_PROJECT_GLOBAL_ID = '0B$fPbwmL4vfKHsnJjuCmp';
export const CRAFTED_SITE_GLOBAL_ID = '3cUkl32yn9qRSPvBJVyWYp';
export const CRAFTED_BUILDING_GLOBAL_ID = '1hqpQexVf9HOCOS7PEqmcw';

/** A layer, its parent and whether Rhino shows it. */
interface CraftedLayer {
  name: string;
  parent?: string;
  visible?: boolean;
  userStrings?: [string, string][];
}

/**
 * One `.3dm` with the layers and objects a tree test needs.
 *
 * `objects` places one triangle per entry on the named layer, hidden when the
 * entry says so. Layers are written in the given order, so a parent is always
 * written before its children, which is what the reader's layer table needs.
 */
async function craftLayeredRhino3dm(
  layers: CraftedLayer[],
  objects: { layer: string; name: string; hidden?: boolean; userStrings?: [string, string][] }[],
): Promise<Uint8Array> {
  const rhino = await rhino3dm();
  const file = new rhino.File3dm();
  file.settings().modelUnitSystem = rhino.UnitSystem.Meters;

  const indexOf = new Map<string, number>();
  const idOf = new Map<string, string>();
  for (const spec of layers) {
    const layer = new rhino.Layer();
    layer.name = spec.name;
    layer.color = { r: 0, g: 0, b: 0, a: 255 };
    layer.visible = spec.visible ?? true;
    if (spec.parent !== undefined) layer.parentLayerId = idOf.get(spec.parent)!;
    for (const [key, value] of spec.userStrings ?? []) layer.setUserString(key, value);
    const index = file.layers().add(layer);
    indexOf.set(spec.name, index);
    idOf.set(spec.name, file.layers().get(index).id);
  }

  for (const [at, spec] of objects.entries()) {
    const mesh = new rhino.Mesh();
    const vertices = mesh.vertices();
    vertices.addPoint3d(at, 0, 0);
    vertices.addPoint3d(at + 1, 0, 0);
    vertices.addPoint3d(at + 1, 1, 0);
    mesh.faces().addTriFace(0, 1, 2);
    const attributes = new rhino.ObjectAttributes();
    attributes.layerIndex = indexOf.get(spec.layer)!;
    attributes.name = spec.name;
    if (spec.hidden) attributes.visible = false;
    for (const [key, value] of spec.userStrings ?? []) attributes.setUserString(key, value);
    file.objects().addMesh(mesh, attributes);
  }

  return file.toByteArray();
}

/**
 * A Rhino-authored file: nested layers, one layer switched off, one hidden
 * object on a visible layer. No `IFC::*` user text anywhere, so the import has
 * only the layers to go on.
 */
export function craftRhinoLayerTree(): Promise<Uint8Array> {
  return craftLayeredRhino3dm(
    [{ name: 'Shell' }, { name: 'Glazing', parent: 'Shell' }, { name: 'Scaffold', visible: false }],
    [
      { layer: 'Shell', name: 'Wall' },
      { layer: 'Glazing', name: 'Window' },
      { layer: 'Shell', name: 'Offcut', hidden: true },
      { layer: 'Scaffold', name: 'Tower' },
    ],
  );
}

/**
 * The shape ifc-lite's own exporter writes: spatial layers carrying
 * `IFC::GlobalId` / `IFC::Class` / `IFC::Elevation`, a class sublayer under the
 * storey that carries no stamp, and one object on it.
 */
export function craftRhinoSpatialLayers(): Promise<Uint8Array> {
  const stamp = (globalId: string, ifcClass: string, elevation?: string): [string, string][] => [
    ['IFC::GlobalId', globalId], ['IFC::Class', ifcClass],
    ...(elevation === undefined ? [] : [['IFC::Elevation', elevation] as [string, string]]),
  ];
  return craftLayeredRhino3dm(
    [
      { name: 'Crafted project', userStrings: stamp(CRAFTED_PROJECT_GLOBAL_ID, 'IfcProject') },
      { name: 'Site', parent: 'Crafted project', userStrings: stamp(CRAFTED_SITE_GLOBAL_ID, 'IfcSite') },
      { name: 'House', parent: 'Site', userStrings: stamp(CRAFTED_BUILDING_GLOBAL_ID, 'IfcBuilding') },
      {
        name: CRAFTED_STOREY.name, parent: 'House',
        userStrings: stamp(CRAFTED_STOREY.globalId, 'IfcBuildingStorey', String(CRAFTED_STOREY.elevation)),
      },
      { name: 'IfcWall', parent: CRAFTED_STOREY.name },
      // A layer the Rhino user added to the export, outside its structure.
      { name: 'Rhino additions' },
    ],
    [
      { layer: 'IfcWall', name: 'South wall', userStrings: [['IFC::GlobalId', CRAFTED_GLOBAL_ID], ['IFC::Class', 'IfcWall']] },
      { layer: 'Site', name: 'Terrain' },
      { layer: 'Rhino additions', name: 'Sketch' },
    ],
  );
}

/**
 * A file whose storey layer states the GlobalId of an object that is not that
 * storey: the same identity on two things of different classes.
 */
export function craftRhinoStampCollision(): Promise<Uint8Array> {
  return craftLayeredRhino3dm(
    [
      {
        name: 'Project', userStrings: [['IFC::GlobalId', CRAFTED_PROJECT_GLOBAL_ID], ['IFC::Class', 'IfcProject']],
      },
      {
        name: CRAFTED_STOREY.name, parent: 'Project',
        userStrings: [['IFC::GlobalId', CRAFTED_STOREY.globalId], ['IFC::Class', 'IfcBuildingStorey']],
      },
    ],
    [
      // The project's own GlobalId on a wall, and the storey's on another.
      { layer: CRAFTED_STOREY.name, name: 'Impostor project', userStrings: [['IFC::GlobalId', CRAFTED_PROJECT_GLOBAL_ID], ['IFC::Class', 'IfcWall']] },
      { layer: CRAFTED_STOREY.name, name: 'Impostor storey', userStrings: [['IFC::GlobalId', CRAFTED_STOREY.globalId], ['IFC::Class', 'IfcWall']] },
    ],
  );
}

/**
 * One element whose parts Rhino shows differently: a shown triangle, a hidden
 * triangle and a hidden point cloud that share a GlobalId and a group, so the
 * reader merges them into one visible entity (D8). Plus an object hidden on
 * its own, with a triangle only, which is a hidden entity.
 */
export async function craftRhinoPartlyHidden(): Promise<Uint8Array> {
  const rhino = await rhino3dm();
  const file = new rhino.File3dm();
  file.settings().modelUnitSystem = rhino.UnitSystem.Meters;
  const layer = new rhino.Layer();
  layer.name = 'Model';
  file.layers().add(layer);
  const group = new rhino.Group();
  group.name = CRAFTED_GLOBAL_ID;
  file.groups().add(group);

  const attributes = (name: string, hidden: boolean, part: boolean) => {
    const a = new rhino.ObjectAttributes();
    a.layerIndex = 0;
    a.name = name;
    a.visible = !hidden;
    if (part) {
      a.addToGroup(0);
      a.setUserString('IFC::GlobalId', CRAFTED_GLOBAL_ID);
    }
    return a;
  };
  const triangle = (x: number) => {
    const mesh = new rhino.Mesh();
    mesh.vertices().addPoint3d(x, 0, 0);
    mesh.vertices().addPoint3d(x + 1, 0, 0);
    mesh.vertices().addPoint3d(x + 1, 1, 0);
    mesh.faces().addTriFace(0, 1, 2);
    return mesh;
  };
  file.objects().addMesh(triangle(0), attributes('Shown part', false, true));
  file.objects().addMesh(triangle(2), attributes('Hidden part', true, true));
  const cloud = new rhino.PointCloud();
  cloud.add([5, 0, 0]);
  file.objects().addPointCloud(cloud, attributes('Hidden cloud', true, true));
  file.objects().addMesh(triangle(8), attributes('Hidden alone', true, false));
  return file.toByteArray();
}

/**
 * What the worker hands the adapter: a real read, baked and axis-swapped by
 * the real worker job. One copy, because every Rhino adapter test needs it.
 */
export async function rhinoImportOf(bytes: Uint8Array): Promise<RhinoImport> {
  const result = await readRhino3dm(bytes, { bakeInstances: true });
  swapRhinoImportAxes(result);
  return result;
}

/** The viewer payload for `bytes`, as `prepareRhinoViewerModel` builds it. */
export async function rhinoPayloadOf(bytes: Uint8Array, fileName = 'crafted.3dm'): Promise<ViewerModelPayload> {
  return rhinoViewerModel(await rhinoImportOf(bytes), bytes.buffer.slice(0) as ArrayBuffer, 7, fileName);
}
