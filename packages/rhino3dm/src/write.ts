/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type factory from 'rhino3dm';
import type { EncodedRhinoScene, RhinoColor, RhinoObject, Write3dmOptions, Write3dmResult } from './types.js';
import { parseRhinoScene, RhinoSceneError } from './parse.js';
import { alignedRhinoBlob, sectionView } from './buffers.js';
import { RHINO_3DM_VERSIONS } from './types.js';
import { dispose, loadRhino } from './runtime.js';

type Rhino = Awaited<ReturnType<typeof factory>>;
type Mesh = InstanceType<Rhino['Mesh']>;
type Attributes = InstanceType<Rhino['ObjectAttributes']>;
function appended<T>(table: { count: number; add(item: T): void }, item: T, kind: string, name: string): number {
  const index = table.count;
  table.add(item);
  if (table.count !== index + 1) throw new RhinoSceneError(`Failed to add ${kind} "${name}"`);
  return index;
}
function storedId(table: { get(index: number): { id: string } }, index: number, kind: string, name: string): string {
  if (index < 0) throw new RhinoSceneError(`Failed to add ${kind} "${name}"`);
  const stored = table.get(index);
  // FindIndex allocates a wrapper retaining a model component reference.
  try { return stored.id; } finally { dispose(stored); }
}
const rgba = ([r, g, b, a]: RhinoColor) => ({ r, g, b, a });

export async function writeRhino3dm(scene: EncodedRhinoScene, opts: Write3dmOptions = {}): Promise<Write3dmResult> {
  const version = opts.version ?? RHINO_3DM_VERSIONS[0];
  if (!RHINO_3DM_VERSIONS.includes(version)) throw new RhinoSceneError('3dm version must be 7 or 8');
  const manifest = parseRhinoScene(scene);
  const blob = alignedRhinoBlob(scene.blob);
  const rhino = await loadRhino(opts.locateFile);
  const file = new rhino.File3dm();
  const handles: unknown[] = [];
  const own = <T>(handle: T): T => { handles.push(handle); return handle; };
  const layerIndices: number[] = [], layerIds: string[] = [], materialIndices: number[] = [], groupIndices: number[] = [];
  const blockIds: string[] = [];
  function addedObject(id: string, name: string): void {
    if (!id || id === '00000000-0000-0000-0000-000000000000') throw new RhinoSceneError(`Failed to add object "${name}"`);
  }
  function mesh(index: number): Mesh {
    const m = new rhino.Mesh();
    try {
      const src = manifest.meshes[index];
      const vertices = m.vertices(), normals = m.normals(), faces = m.faces();
      // These are by-value embind wrappers over mesh data, not borrowed handles.
      try {
        const positions = sectionView(blob, src.positions, Float64Array);
        for (let i = 0; i < positions.length; i += 3) vertices.addPoint3d(positions[i], positions[i + 1], positions[i + 2]);
        if (src.normals) {
          const values = sectionView(blob, src.normals, Float32Array);
          for (let i = 0; i < values.length; i += 3) normals.add(values[i], values[i + 1], values[i + 2]);
        }
        const indices = sectionView(blob, src.indices, Uint32Array);
        for (let i = 0; i < indices.length; i += 3) faces.addTriFace(indices[i], indices[i + 1], indices[i + 2]);
      } finally { dispose(faces); dispose(normals); dispose(vertices); }
      return m;
    } catch (error) { dispose(m); throw error; }
  }
  function attributes(o: RhinoObject): Attributes {
    const a = new rhino.ObjectAttributes();
    try {
      a.name = o.name; a.layerIndex = layerIndices[o.layer];
      a.colorSource = rhino.ObjectColorSource.ColorFromObject; a.objectColor = rgba(o.color);
      a.materialSource = rhino.ObjectMaterialSource.MaterialFromObject; a.materialIndex = materialIndices[o.material];
      for (const g of o.groups) a.addToGroup(groupIndices[g]);
      for (const [k, v] of o.userStrings) a.setUserString(k, v);
      // ObjectAttributes.id is read-only in JS. Identity is IFC::GlobalId user text;
      // see docs/architecture/rhino-3dm-export.md, "Object identity".
      return a;
    } catch (error) { dispose(a); throw error; }
  }
  try {
    // The C++ getters return table/settings wrappers by value. Release the
    // wrappers before File3dm; their underlying document data stays in File3dm.
    const objects = own(file.objects()), layers = own(file.layers()), materials = own(file.materials());
    const groups = own(file.groups()), definitions = own(file.instanceDefinitions()), strings = own(file.strings());
    const settings = own(file.settings()), s = manifest.settings;
    settings.modelUnitSystem = rhino.UnitSystem[s.unitSystem];
    settings.modelAbsoluteTolerance = s.absoluteTolerance;
    settings.modelAngleToleranceRadians = s.angleToleranceDegrees * Math.PI / 180;
    if (s.earthAnchor) {
      const e = s.earthAnchor, anchor = settings.earthAnchorPoint;
      // This getter returns an owned copy; assign it back before releasing it.
      try {
        anchor.earthBasepointLatitude = e.latitude; anchor.earthBasepointLongitude = e.longitude;
        anchor.earthBasepointElevationZero = rhino.BasepointZero.MeanSeaLevel;
        anchor.earthBasepointElevation = e.elevation; anchor.name = e.name;
        anchor.modelBasePoint = e.modelBasePoint; anchor.modelNorth = e.modelNorth; anchor.modelEast = e.modelEast;
        settings.earthAnchorPoint = anchor;
      } finally { dispose(anchor); }
    }
    for (const [k, v] of manifest.documentStrings) strings.set(k, v);
    for (const src of manifest.layers) {
      const l = new rhino.Layer();
      try {
        l.name = src.name; l.color = rgba(src.color); l.visible = src.visible; l.locked = src.locked;
        if (src.parent !== null) l.parentLayerId = layerIds[src.parent];
        const i = layers.add(l);
        layerIds.push(storedId(layers, i, 'layer', src.name));
        layerIndices.push(i);
      } finally { dispose(l); }
    }
    for (const src of manifest.materials) {
      const m = new rhino.Material();
      try {
        m.name = src.name; (m as unknown as { diffuseColor: ReturnType<typeof rgba> }).diffuseColor = rgba([...src.diffuse, 255]); m.transparency = src.transparency;
        materialIndices.push(appended(materials, m, 'material', src.name));
      } finally { dispose(m); }
    }
    for (const src of manifest.groups) {
      const g = new rhino.Group();
      try {
        g.name = src.name;
        groupIndices.push(appended(groups, g, 'group', src.name));
      }
      finally { dispose(g); }
    }
    for (const b of manifest.blocks) {
      const geometries: Mesh[] = [], attrs: Attributes[] = [];
      try {
        for (const i of b.meshes) {
          geometries.push(mesh(i));
          const a = new rhino.ObjectAttributes(); attrs.push(a);
          a.layerIndex = layerIndices[b.layer]; a.colorSource = rhino.ObjectColorSource.ColorFromParent;
          a.materialSource = rhino.ObjectMaterialSource.MaterialFromParent;
        }
        const i = definitions.add(b.name, b.description, '', '', [0, 0, 0], geometries, attrs);
        blockIds.push(storedId(definitions, i, 'block', b.name));
      } finally { attrs.forEach(dispose); geometries.forEach(dispose); }
    }
    opts.onProgress?.(0, manifest.objects.length);
    for (const [i, o] of manifest.objects.entries()) {
      const a = attributes(o);
      try {
        if (o.kind === 'mesh') {
          const m = mesh(o.mesh);
          try { addedObject(objects.addMesh(m, a), o.name); } finally { dispose(m); }
        } else {
          // Upstream omits these two constructor signatures from its declarations.
          const Transform = rhino.Transform as unknown as new (diagonal: number) => InstanceType<Rhino['Transform']>;
          const InstanceReference = rhino.InstanceReference as unknown as new (id: string, transform: InstanceType<Rhino['Transform']>) => InstanceType<Rhino['InstanceReference']>;
          const t = new Transform(1);
          try {
            // mRC are row/column properties; toFloatArray(true) is row-major.
            for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
              const key = `m${row}${col}` as keyof typeof t;
              (t as unknown as Record<string, unknown>)[key] = o.xform[row * 4 + col];
            }
            const instance = new InstanceReference(blockIds[o.block], t);
            try { addedObject(objects.addInstanceObject(instance, a), o.name); } finally { dispose(instance); }
          } finally { dispose(t); }
        }
      } finally { dispose(a); }
      opts.onProgress?.(i + 1, manifest.objects.length);
    }
    const options = new rhino.File3dmWriteOptions();
    try { options.version = version; return { bytes: file.toByteArrayOptions(options), warnings: manifest.warnings, objectCount: manifest.objects.length }; }
    finally { dispose(options); }
  } finally { handles.reverse().forEach(dispose); dispose(file); }
}
