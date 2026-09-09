/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { parseIfcx, parseFederatedIfcx, type IfcxFile } from '@ifc-lite/ifcx';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { Ifc5Exporter } from './ifc5-exporter.js';
import { ALL_OFFICIAL_SCHEMAS, validateValue } from './__fixtures__/ifc5-official-schemas.js';

const fixture = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('texture.ifc','2026-09-09T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,$,$);
#5=IFCWALL('0000000000000000000005',$,'Wall A',$,$,$,$,$);
#6=IFCWALL('0000000000000000000006',$,'Wall B',$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

const pixels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 255, 255, 0, 0]);
function mesh(id: number, textured = true): MeshData {
  return {
    expressId: id, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    color: [0.2, 0.4, 0.6, 0.7],
    ...(textured ? { uvs: new Float32Array([0.25, 0.75, 2, -1, 0, 1]),
      texture: { rgba: pixels, width: 2, height: 2, repeatS: true, repeatT: false } } : {}),
  };
}

async function exported(meshes: MeshData[], hidden?: Set<number>) {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(fixture).buffer);
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } };
  const geometry: GeometryResult = { meshes, totalVertices: meshes.length * 3, totalTriangles: meshes.length,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } };
  return new Ifc5Exporter(store, geometry).export({ onlyTreeEntities: false, visibleOnly: !!hidden, hiddenEntityIds: hidden });
}

describe('IFCX textured fragment transport (#4325)', () => {
  it('roundtrips mixed fragments, shared image bytes, sampler and owner identity through the real exporter/reader', async () => {
    const source = [mesh(5), mesh(5, false), mesh(6)];
    const result = await exported(source);
    const file: IfcxFile = JSON.parse(result.content);
    for (const node of file.data) for (const [key, value] of Object.entries(node.attributes ?? {})) {
      const schema = file.schemas[key] ?? ALL_OFFICIAL_SCHEMAS[key];
      expect(schema, key).toBeDefined();
      expect(validateValue(value, schema.value, key)).toEqual([]);
    }
    expect(file.data.filter((node) => node.attributes?.['ifclite::image::v1'])).toHaveLength(1);
    const reopened = await parseIfcx(new TextEncoder().encode(result.content).buffer);
    expect(reopened.meshes).toHaveLength(3);
    const layered = await parseFederatedIfcx([{ name: 'appearance.ifcx', buffer: new TextEncoder().encode(result.content).buffer }]);
    expect(layered.meshes).toHaveLength(3);
    const textured = reopened.meshes.filter((part) => part.texture);
    expect(textured).toHaveLength(2);
    expect(textured[0].texture!.rgba).toEqual(pixels);
    expect(textured[0].texture!.rgba).toBe(textured[1].texture!.rgba);
    for (const part of textured) {
      expect(part.uvs).toEqual(source[0].uvs);
      expect(part.texture!.repeatS).toBe(true);
      expect(part.texture!.repeatT).toBe(false);
      expect(reopened.idToPath.get(part.expressId)).toMatch(/000000000000000000000[56]$/);
    }
    expect(reopened.meshes.map((part) => part.indices.length)).toEqual([3, 3, 3]);
  });

  it('keeps different dimensions distinct even when two textures share the same pixel buffer', async () => {
    const a = mesh(5);
    const b = mesh(6);
    b.texture = { ...b.texture!, width: 1, height: 4 };
    const file: IfcxFile = JSON.parse((await exported([a, b])).content);
    expect(file.data.filter((node) => node.attributes?.['ifclite::image::v1'])).toHaveLength(2);
    const reopened = await parseIfcx(new TextEncoder().encode(JSON.stringify(file)).buffer);
    expect(reopened.meshes.map((part) => [part.texture!.width, part.texture!.height])).toEqual([[2, 2], [1, 4]]);
  });

  it('exports only visible owner images and leaves the untextured standard representation unchanged', async () => {
    const result = await exported([mesh(5, false), mesh(6)], new Set([6]));
    const file: IfcxFile = JSON.parse(result.content);
    expect(file.schemas).toEqual({});
    const reopened = await parseIfcx(new TextEncoder().encode(result.content).buffer);
    expect(reopened.meshes).toHaveLength(1);
    expect(reopened.meshes[0].texture).toBeUndefined();
  });

  it('refuses an unresolved image or mismatched UVs instead of returning a white successful export', async () => {
    const missing = mesh(5);
    delete missing.texture;
    missing.textureRef = { textureId: 100, url: 'missing.png', repeatS: false, repeatT: false };
    await expect(exported([missing])).rejects.toThrow('unresolved IFCX texture');
    const invalid = mesh(5);
    invalid.uvs = new Float32Array([0, 0]);
    await expect(exported([invalid])).rejects.toThrow('UV pair');
  });
});
