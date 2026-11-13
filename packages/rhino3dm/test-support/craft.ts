/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { crc32 } from 'node:zlib';
import { loadRhino, type Rhino } from '../src/runtime.js';
import type { RhinoColor, RhinoImport, RhinoUserStrings, RhinoVector3 } from '../src/index.js';

/**
 * Builds .3dm files for the reader tests through rhino3dm itself, so the tests
 * need no fixture download. Handles are not released: a test process is short.
 */
type Mesh = InstanceType<Rhino['Mesh']>;
type Attributes = InstanceType<Rhino['ObjectAttributes']>;
type Geometry = InstanceType<Rhino['GeometryBase']>;
type Transform = InstanceType<Rhino['Transform']>;

export interface AttributeSpec {
  name?: string; layer?: number; groups?: number[]; userStrings?: RhinoUserStrings; hidden?: boolean;
  color?: RhinoColor; colorSource?: 'ColorFromLayer' | 'ColorFromObject' | 'ColorFromMaterial' | 'ColorFromParent';
  material?: number; materialSource?: 'MaterialFromLayer' | 'MaterialFromObject' | 'MaterialFromParent';
}
export interface LayerSpec { parent?: number; color?: RhinoColor; visible?: boolean; material?: number; userStrings?: RhinoUserStrings }

const rgba = ([r, g, b, a]: RhinoColor) => ({ r, g, b, a });
export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export const translation = (x: number, y: number, z: number) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];

export class Craft {
  readonly file: InstanceType<Rhino['File3dm']>;
  private readonly layerIds: string[] = [];

  constructor(readonly rhino: Rhino) {
    this.file = new rhino.File3dm();
    this.units('Meters');
  }

  units(name: keyof Rhino['UnitSystem']): this {
    this.file.settings().modelUnitSystem = this.rhino.UnitSystem[name];
    return this;
  }

  string(key: string, value: string): this {
    this.file.strings().set(key, value);
    return this;
  }

  layer(name: string, spec: LayerSpec = {}): number {
    const layer = new this.rhino.Layer();
    layer.name = name;
    layer.color = rgba(spec.color ?? [0, 0, 0, 255]);
    layer.visible = spec.visible ?? true;
    if (spec.material !== undefined) layer.renderMaterialIndex = spec.material;
    if (spec.parent !== undefined) layer.parentLayerId = this.layerIds[spec.parent];
    for (const [key, value] of spec.userStrings ?? []) layer.setUserString(key, value);
    const index = this.file.layers().add(layer);
    this.layerIds[index] = this.file.layers().get(index).id;
    return index;
  }

  material(name: string, diffuse: RhinoColor, transparency = 0): number {
    const material = new this.rhino.Material(), table = this.file.materials();
    material.name = name;
    (material as unknown as { diffuseColor: object }).diffuseColor = rgba(diffuse);
    material.transparency = transparency;
    table.add(material);
    return table.count - 1;
  }

  group(name: string): number {
    const group = new this.rhino.Group(), table = this.file.groups();
    group.name = name;
    table.add(group);
    return table.count - 1;
  }

  attributes(spec: AttributeSpec = {}): Attributes {
    const a = new this.rhino.ObjectAttributes();
    if (spec.name !== undefined) a.name = spec.name;
    if (spec.layer !== undefined) a.layerIndex = spec.layer;
    if (spec.hidden) a.visible = false;
    if (spec.color) a.objectColor = rgba(spec.color);
    if (spec.color || spec.colorSource) a.colorSource = this.rhino.ObjectColorSource[spec.colorSource ?? 'ColorFromObject'];
    if (spec.material !== undefined) a.materialIndex = spec.material;
    if (spec.materialSource) a.materialSource = this.rhino.ObjectMaterialSource[spec.materialSource];
    for (const group of spec.groups ?? []) a.addToGroup(group);
    for (const [key, value] of spec.userStrings ?? []) a.setUserString(key, value);
    return a;
  }

  /** A mesh from vertices and faces of three or four vertex indices. */
  mesh(points: number[][], faces: number[][]): Mesh {
    const mesh = new this.rhino.Mesh(), vertices = mesh.vertices(), list = mesh.faces();
    for (const [x, y, z] of points) vertices.addPoint3d(x, y, z);
    for (const f of faces) {
      if (f.length === 4) list.addQuadFace(f[0], f[1], f[2], f[3]); else list.addTriFace(f[0], f[1], f[2]);
    }
    return mesh;
  }

  /** An axis-aligned box of six quads: twelve triangles once read. */
  box(min: RhinoVector3, max: RhinoVector3): Mesh {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    return this.mesh(
      [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
      [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]],
    );
  }

  addMesh(mesh: Mesh, spec?: AttributeSpec): string { return this.file.objects().addMesh(mesh, this.attributes(spec)); }
  addCurve(curve: InstanceType<Rhino['Curve']>, spec?: AttributeSpec): string { return this.file.objects().addCurve(curve, this.attributes(spec)); }
  addPolyline(points: number[][], spec?: AttributeSpec): string { return this.addCurve(new this.rhino.PolylineCurve(points), spec); }
  addPoint(point: RhinoVector3, spec?: AttributeSpec): string { return this.file.objects().addPoint(point, this.attributes(spec)); }
  addTextDot(text: string, point: RhinoVector3, spec?: AttributeSpec): string { return this.file.objects().addTextDot(text, point, this.attributes(spec)); }

  addPointCloud(points: number[][], colors?: RhinoColor[], spec?: AttributeSpec): string {
    const cloud = new this.rhino.PointCloud();
    points.forEach((p, i) => { if (colors) cloud.addPointColor(p, rgba(colors[i])); else cloud.add(p); });
    return this.file.objects().addPointCloud(cloud, this.attributes(spec));
  }

  /** A six-face box Brep with render meshes on the first `meshedFaces` faces. rhino3dm cannot mesh, so each is one quad. */
  addBrep(meshedFaces: number, spec?: AttributeSpec): string {
    const brep = this.rhino.Brep.createFromBoundingBox(new this.rhino.BoundingBox([0, 0, 0], [1, 2, 3]));
    const faces = brep.faces();
    for (let i = 0; i < meshedFaces; i++) {
      const quad = this.mesh([[0, 0, i], [1, 0, i], [1, 2, i], [0, 2, i]], [[0, 1, 2, 3]]);
      // Upstream's .d.ts has the two arguments the wrong way round.
      (faces.get(i) as unknown as { setMesh(mesh: Mesh, type: unknown): boolean }).setMesh(quad, this.rhino.MeshType.Render);
    }
    return this.file.objects().addBrep(brep, this.attributes(spec));
  }

  addExtrusion(withMesh: boolean, spec?: AttributeSpec): string {
    const extrusion = this.rhino.Extrusion.createCylinderExtrusion(new this.rhino.Cylinder(new this.rhino.Circle(1), 2), true, true);
    if (withMesh) extrusion.setMesh(this.box([0, 0, 0], [1, 1, 2]), this.rhino.MeshType.Render);
    return this.file.objects().addExtrusion(extrusion, this.attributes(spec));
  }

  transform(rowMajor: number[]): Transform {
    const Transform = this.rhino.Transform as unknown as new (diagonal: number) => Transform;
    const t = new Transform(1) as unknown as Record<string, number>;
    for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) t[`m${row}${col}`] = rowMajor[row * 4 + col];
    return t as unknown as Transform;
  }

  /** A text dot as block member geometry. Upstream's .d.ts omits the constructor arguments. */
  textDot(text: string, point: RhinoVector3): Geometry {
    return new (this.rhino.TextDot as unknown as new (text: string, point: number[]) => Geometry)(text, point);
  }

  /** A reference to a block, as block member geometry or for `addInstance`. */
  reference(block: string, rowMajor: number[] = IDENTITY): Geometry {
    const InstanceReference = this.rhino.InstanceReference as unknown as new (id: string, transform: Transform) => Geometry;
    return new InstanceReference(block, this.transform(rowMajor));
  }

  /** Define a block from geometry; returns its id. Member attributes default to "by parent" colour. */
  block(name: string, members: Geometry[], specs: AttributeSpec[] = []): string {
    const table = this.file.instanceDefinitions();
    const attributes = members.map((_, i) => this.attributes(specs[i] ?? { colorSource: 'ColorFromParent' }));
    const index = table.add(name, '', '', '', [0, 0, 0], members, attributes);
    return table.get(index).id;
  }

  addInstance(block: string, rowMajor: number[] = IDENTITY, spec?: AttributeSpec): string {
    return this.file.objects().addInstanceObject(this.reference(block, rowMajor) as InstanceType<Rhino['InstanceReference']>, this.attributes(spec));
  }

  bytes(): Uint8Array { return this.file.toByteArray(); }
}

/** Build a .3dm in metres and return its bytes. */
export async function craft(build: (c: Craft) => void): Promise<Uint8Array> {
  const c = new Craft(await loadRhino());
  build(c);
  return c.bytes();
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** A UUID as openNURBS stores it: the first three fields little-endian. */
function uuidBytes(uuid: string): Buffer {
  const b = Buffer.from(uuid.replace(/-/g, ''), 'hex');
  return Buffer.from([b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6], ...b.subarray(8)]);
}

/**
 * Replace one stored UUID with another and repair the CRC of the chunk around
 * it. This is how the tests get a block that references itself: rhino3dm only
 * hands out a definition's id after its members are fixed.
 */
export function patchUuid(bytes: Uint8Array, from: string, to: string): Uint8Array {
  const original = Buffer.from(bytes), patched = Buffer.from(bytes), at = original.indexOf(uuidBytes(from));
  if (at < 0 || original.indexOf(uuidBytes(from), at + 1) >= 0) throw new Error(`expected exactly one ${from} in the archive`);
  uuidBytes(to).copy(patched, at);
  // Find every chunk that ends in the CRC-32 of its own bytes and covers the patch, innermost first.
  const window = 4096, chunks: [start: number, end: number][] = [];
  for (let start = Math.max(0, at - window); start <= at; start++) {
    // A running table CRC: calling zlib once per byte makes this scan take seconds.
    let crc = 0xffffffff;
    for (let end = start; end < Math.min(original.length - 4, at + window); end++) {
      crc = CRC_TABLE[(crc ^ original[end]) & 0xff] ^ (crc >>> 8);
      if (end + 1 >= at + 16 && original.readUInt32LE(end + 1) === (crc ^ 0xffffffff) >>> 0) chunks.push([start, end + 1]);
    }
  }
  if (chunks.length === 0) throw new Error('found no CRC-protected chunk around the patched id');
  chunks.sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]));
  for (const [start, end] of chunks) patched.writeUInt32LE(crc32(patched.subarray(start, end)), end);
  return new Uint8Array(patched);
}

export interface Bounds { min: RhinoVector3; max: RhinoVector3 }

/** World bounding box of everything an entity draws as triangles, instances included. */
export function entityBounds(result: RhinoImport, entity: number): Bounds {
  const min: RhinoVector3 = [Infinity, Infinity, Infinity], max: RhinoVector3 = [-Infinity, -Infinity, -Infinity];
  const grow = (g: { origin: RhinoVector3; positions: Float32Array }, m?: number[]) => {
    for (let i = 0; i < g.positions.length; i += 3) {
      let p = [g.origin[0] + g.positions[i], g.origin[1] + g.positions[i + 1], g.origin[2] + g.positions[i + 2]];
      if (m) p = [0, 4, 8].map(r => m[r] * p[0] + m[r + 1] * p[1] + m[r + 2] * p[2] + m[r + 3]);
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
    }
  };
  for (const mesh of result.meshes) if (mesh.entity === entity) grow(mesh);
  for (const instance of result.instances) {
    if (instance.entity === entity) for (const mesh of result.definitions[instance.definition].meshes) grow(mesh, instance.transform);
  }
  return { min, max };
}

/** Triangles an import draws: meshes plus every placed block. */
export function drawnTriangles(result: RhinoImport): number {
  const perDefinition = result.definitions.map(d => d.meshes.reduce((n, m) => n + m.indices.length / 3, 0));
  return result.meshes.reduce((n, m) => n + m.indices.length / 3, 0) + result.instances.reduce((n, i) => n + perDefinition[i.definition], 0);
}
