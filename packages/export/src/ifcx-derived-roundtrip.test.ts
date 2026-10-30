/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Loading must not change what export writes. The IFCX reader derives an IfcWindowType from a node the file
 * calls IfcWindow, and IfcMaterial rows from class-less nodes, so consumers read them as IFC does; the exporter
 * must still write the file's own classes: the same nodes, with the same `bsi::ifc::class`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { composeIfcx, parseIfcx, type IfcxFile } from '@ifc-lite/ifcx';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult } from '@ifc-lite/geometry';
import { Ifc5Exporter } from './ifc5-exporter.js';

const SAMPLE = resolve(__dirname, '../../../apps/viewer/public/samples/hello-wall.ifcx');
const TYPE = '25503984-6605-43a1-8597-eae657ff5bea';
const MATERIALS = ['7a187a90-3dcf-58cc-b3a6-51a9a407c55a', '4549bada-a37e-5044-bb70-456516cca5a8', 'd10e4eb4-6a35-5fbe-9491-7a6fb93f1691'];

const classOf = (attributes: Record<string, unknown> | Map<string, unknown> | undefined): string | undefined => {
  const value = attributes instanceof Map ? attributes.get('bsi::ifc::class') : attributes?.['bsi::ifc::class'];
  return (value as { code?: string } | undefined)?.code;
};

describe('export writes the classes the file states, not the ones the reader derived', () => {
  it('load hello-wall.ifcx, export, and the class of every node is the source\'s', async () => {
    const bytes = readFileSync(SAMPLE);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const parsed = await parseIfcx(buffer);
    // The reader does derive them: the table says IfcWindowType and has the materials.
    expect(parsed.entities.getTypeName(parsed.pathToId.get(TYPE)!)).toBe('IfcWindowType');
    expect(MATERIALS.every((path) => parsed.pathToId.has(path))).toBe(true);

    const store = { ...parsed, source: new Uint8Array(0), entityIndex: { byId: new Map(), byType: new Map() } } as unknown as IfcDataStore;
    const out = new Ifc5Exporter(store, { meshes: parsed.meshes } as unknown as GeometryResult)
      .export({ onlyTreeEntities: false, onlyKnownProperties: false });
    const exported = new Map<string, string>();
    for (const node of (JSON.parse(out.content) as IfcxFile).data) {
      const code = classOf(node.attributes);
      if (code) exported.set(node.path, code);
    }

    const source = new Map<string, string>();
    for (const node of composeIfcx(JSON.parse(readFileSync(SAMPLE, 'utf8')) as IfcxFile).values()) {
      const code = classOf(node.attributes);
      if (code) source.set(node.path, code);
    }
    expect(Object.fromEntries(exported)).toEqual(Object.fromEntries(source));
    expect(exported.get(TYPE)).toBe('IfcWindow');
    for (const path of MATERIALS) expect(exported.has(path)).toBe(false);
  });
});
