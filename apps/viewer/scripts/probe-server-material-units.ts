/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Real authoring-tool mixed-unit oracle for #5296. After `pnpm fixtures`:
 * pnpm exec tsx --tsconfig apps/viewer/tsconfig.json apps/viewer/scripts/probe-server-material-units.ts prepare /tmp/ifc5296-merged.ifc
 * IFCLITE_MATERIAL_MERGED_IN=/tmp/ifc5296-merged.ifc IFCLITE_MATERIAL_PARQUET_OUT=/tmp/ifc5296-merged.bin cargo test -p ifc-lite-server material_layer_thickness_uses_owning_project_units_5296
 * pnpm exec tsx --tsconfig apps/viewer/tsconfig.json apps/viewer/scripts/probe-server-material-units.ts check /tmp/ifc5296-merged.ifc /tmp/ifc5296-merged.bin
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { MergedExporter } from '@ifc-lite/export';
import { IfcParser, extractMaterialsOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { decodeDataModel } from '@ifc-lite/server-client';
import { convertServerDataModel } from '../src/utils/serverDataModel.js';

const [phase, mergedPath, parquetPath] = process.argv.slice(2);
if (!mergedPath || (phase !== 'prepare' && (phase !== 'check' || !parquetPath))) {
  throw new Error('usage: probe-server-material-units.ts prepare <merged.ifc> | check <merged.ifc> <data-model.bin>');
}
const parse = (bytes: Buffer | Uint8Array) =>
  new IfcParser().parseColumnar(Uint8Array.from(bytes).buffer, { disableWorkerScan: true });

if (phase === 'prepare') {
  const a = await parse(readFileSync('tests/models/issues/856_wall_decode_failed.ifc'));
  const b = await parse(readFileSync('tests/models/buildingsmart/wall-with-opening-and-window.ifc'));
  assert.equal(a.lengthUnitScale, 0.0254);
  assert.equal(b.lengthUnitScale, 0.001);
  const merged = new MergedExporter([
    { id: 'inches', name: 'Inches', dataStore: a },
    { id: 'millimetres', name: 'Millimetres', dataStore: b },
  ]).export({ schema: 'IFC4' });
  assert.ok(merged.stats.federatedModelCount > 0);
  writeFileSync(mergedPath, merged.content);
  console.log(`Wrote federated inch + millimetre IFC to ${mergedPath}`);
} else {
  const source = readFileSync(mergedPath);
  const raw = await parse(source);
  const payload = Uint8Array.from(readFileSync(parquetPath)).buffer;
  const model = await decodeDataModel(payload);
  const server = convertServerDataModel(model, {
    cache_key: 'material-units-parity',
    metadata: { schema_version: raw.schemaVersion },
    stats: { total_time_ms: 0, parse_time_ms: 0, geometry_time_ms: 0, total_vertices: 0, total_triangles: 0 },
  }, { size: source.length }, []);
  const rawIdForGuid = (guid: string): number => {
    for (const [id, ref] of raw.entityIndex.byId) {
      if (raw.source!.decodeUtf8(ref.byteOffset, ref.byteOffset + ref.byteLength).includes(`'${guid}'`)) return id;
    }
    throw new Error(`raw entity with GlobalId ${guid} missing`);
  };
  const serverIdForGuid = (guid: string): number => {
    for (const entity of model.entities.values()) if (entity.global_id === guid) return entity.entity_id;
    throw new Error(`server entity with GlobalId ${guid} missing`);
  };
  const thickness = (store: IfcDataStore, id: number) =>
    extractMaterialsOnDemand(store, id)?.layers?.[0]?.thickness;
  for (const [guid, expected] of [
    ['20WrgxqpbDtferON_k1P2X', 6 * 0.0254],
    ['3ZYW59sxj8lei475l7EhLU', 0.3],
  ] as const) {
    const rawValue = thickness(raw, rawIdForGuid(guid));
    const serverValue = thickness(server, serverIdForGuid(guid));
    assert.ok(rawValue !== undefined && Math.abs(rawValue - expected) < 1e-9, `${guid} raw thickness`);
    assert.ok(serverValue !== undefined && Math.abs(serverValue - rawValue) < 1e-9, `${guid} server thickness`);
    console.log(`${guid}: raw=${rawValue}m server=${serverValue}m`);
  }
  console.log('PASS: both real merged IFC material layer thicknesses match raw and server stores');
}
