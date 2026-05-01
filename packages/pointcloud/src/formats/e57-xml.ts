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

export interface Data3DEntry {
  guid: string;
  name?: string;
  recordCount: number;
  /** Logical offset into the file where the binary section begins. */
  binaryFileOffset: number;
  /** Field declarations in record order. */
  prototype: PrototypeField[];
  /**
   * Whether this Data3D defines a `pose` element (translation +
   * rotation that places the scan in the file's global frame). We
   * don't apply the transform yet — single-scan files don't need it,
   * and multi-scan files with poses are rejected upfront so we never
   * silently merge in scan-local space.
   */
  hasPose?: boolean;
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
      hasPose: childByName(scan, 'pose') !== null,
    });
  }
  return entries;
}

export function findField(proto: PrototypeField[], name: string): PrototypeField | undefined {
  return proto.find((p) => p.name === name);
}
