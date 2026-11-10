/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { alignedRhinoBlob, sectionView } from './buffers.js';
import type { EncodedRhinoScene, RhinoSceneManifest } from './types.js';

export class RhinoSceneError extends Error {
  constructor(message: string) { super(message); this.name = 'RhinoSceneError'; }
}
function check(ok: unknown, path: string): asserts ok {
  if (!ok) throw new RhinoSceneError(`Invalid RhinoScene: ${path}`);
}
function record(v: unknown, p: string): Record<string, unknown> {
  check(v !== null && typeof v === 'object' && !Array.isArray(v), p);
  return v as Record<string, unknown>;
}
function array(v: unknown, p: string): unknown[] { check(Array.isArray(v), p); return v; }
function str(v: unknown, p: string) { check(typeof v === 'string', p); }
function num(v: unknown, p: string): asserts v is number { check(typeof v === 'number' && Number.isFinite(v), p); }
function vector(v: unknown, n: number, p: string, color = false) {
  const a = array(v, p); check(a.length === n, p);
  a.forEach(x => { num(x, p); if (color) check(Number.isInteger(x) && x >= 0 && x <= 255, p); });
}
function strings(v: unknown, p: string) {
  array(v, p).forEach(x => { const a = array(x, p); check(a.length === 2, p); a.forEach(s => str(s, p)); });
}
function index(v: unknown, length: number, p: string) {
  // Runs once per triangle index: build the message only on failure.
  if (!(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < length)) check(false, `${p} index out of range`);
}

/** Validate the untrusted JSON and all binary references before initializing WASM. */
export function parseRhinoScene(scene: EncodedRhinoScene): RhinoSceneManifest {
  return readRhinoScene(scene).manifest;
}

/** Parse and validate once, returning the manifest with the aligned blob it was checked against. */
export function readRhinoScene(scene: EncodedRhinoScene): { manifest: RhinoSceneManifest; blob: Uint8Array } {
  let json: unknown;
  try { json = JSON.parse(scene.manifest); }
  catch (cause) { throw new RhinoSceneError(`Invalid RhinoScene JSON: ${String(cause)}`); }
  const m = record(json, 'manifest');
  check(m.format === 'ifc-lite.rhino-scene', 'format (expected ifc-lite.rhino-scene)');
  check(m.version === 1, 'version (only 1 is supported)');
  check(scene.blob instanceof Uint8Array, 'blob must be Uint8Array');
  const s = record(m.settings, 'settings');
  check(typeof s.unitSystem === 'string' && ['Millimeters', 'Centimeters', 'Meters', 'Feet', 'Inches'].includes(s.unitSystem), 'unitSystem');
  for (const k of ['metersPerUnit', 'absoluteTolerance', 'angleToleranceDegrees']) { num(s[k], k); check(s[k] > 0, k); }
  if (s.earthAnchor !== null) {
    const e = record(s.earthAnchor, 'earthAnchor');
    for (const k of ['latitude', 'longitude', 'elevation']) num(e[k], k);
    for (const k of ['modelBasePoint', 'modelNorth', 'modelEast']) vector(e[k], 3, k);
    str(e.name, 'earthAnchor.name');
  }
  array(m.warnings, 'warnings').forEach(v => str(v, 'warning'));
  strings(m.documentStrings, 'documentStrings');
  const layers = array(m.layers, 'layers'), materials = array(m.materials, 'materials');
  const groups = array(m.groups, 'groups'), meshes = array(m.meshes, 'meshes');
  const blocks = array(m.blocks, 'blocks'), objects = array(m.objects, 'objects');
  layers.forEach((v, i) => {
    const l = record(v, `layers[${i}]`); str(l.name, 'layer.name');
    if (l.parent !== null) index(l.parent, i, 'parent (must precede child)');
    vector(l.color, 4, 'layer.color', true);
    check(typeof l.visible === 'boolean' && typeof l.locked === 'boolean', 'layer visibility/locked');
  });
  materials.forEach(v => { const a = record(v, 'material'); str(a.name, 'material.name'); vector(a.diffuse, 3, 'diffuse', true); num(a.transparency, 'transparency'); check(a.transparency >= 0 && a.transparency <= 1, 'transparency'); });
  groups.forEach(v => str(record(v, 'group').name, 'group.name'));
  const blob = alignedRhinoBlob(scene.blob);
  function buffer(v: unknown, width: number, p: string) {
    const b = record(v, p);
    check(typeof b.offset === 'number' && Number.isSafeInteger(b.offset) && b.offset >= 0, `${p}.offset`);
    check(typeof b.count === 'number' && Number.isSafeInteger(b.count) && b.count >= 0, `${p}.count`);
    check(b.offset % width === 0, `${p} misaligned offset (requires ${width} bytes)`);
    check(b.count <= Math.floor((scene.blob.byteLength - b.offset) / width), `${p} buffer out of range`);
    check(b.count % 3 === 0, `${p}.count must be a multiple of 3`);
    return { offset: b.offset, count: b.count };
  }
  meshes.forEach(v => {
    const a = record(v, 'mesh');
    const p = buffer(a.positions, 8, 'positions');
    for (const value of sectionView(blob, p, Float64Array)) num(value, 'position');
    if (a.normals !== null) {
      const n = buffer(a.normals, 4, 'normals'); check(n.count === p.count, 'normals count must match positions');
      for (const value of sectionView(blob, n, Float32Array)) num(value, 'normal');
    }
    const t = buffer(a.indices, 4, 'indices');
    for (const value of sectionView(blob, t, Uint32Array)) index(value, p.count / 3, 'triangle vertex');
  });
  blocks.forEach(v => { const b = record(v, 'block'); str(b.name, 'block.name'); str(b.description, 'block.description'); index(b.layer, layers.length, 'block.layer'); array(b.meshes, 'block.meshes').forEach(i => index(i, meshes.length, 'block.mesh')); });
  objects.forEach(v => {
    const o = record(v, 'object');
    check(o.kind === 'mesh' || o.kind === 'instance', 'object.kind');
    if (o.kind === 'mesh') index(o.mesh, meshes.length, 'object.mesh');
    else { index(o.block, blocks.length, 'object.block'); vector(o.xform, 16, 'xform'); }
    index(o.layer, layers.length, 'object.layer'); index(o.material, materials.length, 'object.material');
    str(o.name, 'object.name'); str(o.objectId, 'object.objectId'); vector(o.color, 4, 'object.color', true);
    array(o.groups, 'object.groups').forEach(i => index(i, groups.length, 'object.group'));
    strings(o.userStrings, 'object.userStrings');
  });
  return { manifest: m as unknown as RhinoSceneManifest, blob };
}
