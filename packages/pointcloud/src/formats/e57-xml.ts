/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * E57 XML model + parser.
 *
 * The XML carries the `data3D` structure: per-scan record counts, the
 * binary CompressedVector fileOffset, and the prototype field
 * declarations (`Float`, `Integer`, `ScaledInteger`) that describe the
 * binary record layout.
 */

import {
  childByName,
  childrenByName,
  parseXml,
  textChild,
} from '../xml-mini.js';

export interface PrototypeField {
  name: string;
  kind: 'Float' | 'ScaledInteger' | 'Integer';
  precision?: 'single' | 'double';
  scale?: number;
  offset?: number;
  minimum?: number;
  maximum?: number;
}

/**
 * Per-scan pose: rotation (unit quaternion w + xi + yj + zk) +
 * translation (in source-frame metres). Optional because most
 * single-scan exports don't need one — when absent we treat the
 * scan as already in the file's global frame (identity pose).
 */
export interface E57Pose {
  rotation: { w: number; x: number; y: number; z: number };
  translation: { x: number; y: number; z: number };
}

export interface Data3DEntry {
  guid: string;
  name?: string;
  recordCount: number;
  /** Logical offset into the file where the binary section begins. */
  binaryFileOffset: number;
  /** Field declarations in record order. */
  prototype: PrototypeField[];
  /**
   * Per-Data3D pose that places the scan into the file's global
   * frame. Applied by `decodeE57` before merging multi-scan files;
   * single-scan files where the pose is identity / absent are no-ops.
   */
  pose?: E57Pose;
}

/**
 * Parse the E57 XML section.
 *
 * Uses our own minimal SAX-style parser (`xml-mini.ts`) instead of
 * `DOMParser` because dedicated Web Workers — where the decode runs —
 * don't expose DOMParser. The shape we need (e57Root → data3D →
 * vectorChild → prototype) is shallow and attribute-heavy, well within
 * the mini parser's scope.
 */
export function parseE57Xml(xmlText: string): Data3DEntry[] {
  const root = parseXml(xmlText);
  if (root.name !== 'e57Root') {
    throw new Error(`E57: XML root is not <e57Root> (saw <${root.name || '?'}>)`);
  }
  const data3D = childByName(root, 'data3D');
  if (!data3D) return [];
  const entries: Data3DEntry[] = [];
  for (const scan of childrenByName(data3D, 'vectorChild')) {
    const points = childByName(scan, 'points');
    if (!points) continue;
    if (points.attrs.get('type') !== 'CompressedVector') {
      // Skip non-compressed-vector points (rare).
      continue;
    }
    const fileOffsetAttr = points.attrs.get('fileOffset');
    const recordCountAttr = points.attrs.get('recordCount');
    if (!fileOffsetAttr || !recordCountAttr) continue;
    const proto = childByName(points, 'prototype');
    if (!proto) continue;
    const fields: PrototypeField[] = [];
    for (const f of proto.children) {
      const type = f.attrs.get('type') ?? '';
      if (type === 'Float') {
        fields.push({
          name: f.name,
          kind: 'Float',
          precision: f.attrs.get('precision') === 'single' ? 'single' : 'double',
        });
      } else if (type === 'ScaledInteger') {
        fields.push({
          name: f.name,
          kind: 'ScaledInteger',
          scale: Number(f.attrs.get('scale') ?? '1'),
          offset: Number(f.attrs.get('offset') ?? '0'),
          minimum: Number(f.attrs.get('minimum') ?? '0'),
          maximum: Number(f.attrs.get('maximum') ?? '0'),
        });
      } else if (type === 'Integer') {
        fields.push({
          name: f.name,
          kind: 'Integer',
          minimum: Number(f.attrs.get('minimum') ?? '0'),
          maximum: Number(f.attrs.get('maximum') ?? '0'),
        });
      }
      // Other types (e.g. String) ignored — never carry point data.
    }
    entries.push({
      guid: textChild(scan, 'guid') ?? '',
      name: textChild(scan, 'name') ?? undefined,
      recordCount: Number(recordCountAttr),
      binaryFileOffset: Number(fileOffsetAttr),
      prototype: fields,
      pose: parsePoseElement(childByName(scan, 'pose')) ?? undefined,
    });
  }
  return entries;
}

/**
 * Parse a `<pose>` element to a quaternion + translation pair.
 * Returns null when the element is missing or malformed (any field
 * unparseable → fall back to identity rather than reject the file).
 */
function parsePoseElement(poseEl: ReturnType<typeof childByName>): E57Pose | null {
  if (!poseEl) return null;
  const rotation = childByName(poseEl, 'rotation');
  const translation = childByName(poseEl, 'translation');
  if (!rotation || !translation) return null;
  const qw = Number(textChild(rotation, 'w') ?? '1');
  const qx = Number(textChild(rotation, 'x') ?? '0');
  const qy = Number(textChild(rotation, 'y') ?? '0');
  const qz = Number(textChild(rotation, 'z') ?? '0');
  const tx = Number(textChild(translation, 'x') ?? '0');
  const ty = Number(textChild(translation, 'y') ?? '0');
  const tz = Number(textChild(translation, 'z') ?? '0');
  if (![qw, qx, qy, qz, tx, ty, tz].every(Number.isFinite)) return null;
  return {
    rotation: { w: qw, x: qx, y: qy, z: qz },
    translation: { x: tx, y: ty, z: tz },
  };
}

export function findField(proto: PrototypeField[], name: string): PrototypeField | undefined {
  return proto.find((p) => p.name === name);
}
