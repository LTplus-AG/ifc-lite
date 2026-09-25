/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Manual real-model oracle for #5296. Generate the wire payload with:
 * IFCLITE_MATERIAL_PARQUET_OUT=/tmp/duplex-datamodel.bin cargo test -p ifc-lite-server forwards_revit_duplex_material_associations_with_identity_5296
 * Then run:
 * pnpm exec tsx --tsconfig apps/viewer/tsconfig.json apps/viewer/scripts/probe-server-material-parity.ts tests/models/ara3d/duplex.ifc /tmp/duplex-datamodel.bin 'Masonry - Brick'
 */
import { readFileSync } from 'node:fs';
import { decodeDataModel } from '@ifc-lite/server-client';
import { IfcParser } from '@ifc-lite/parser';
import { createDataAccessor } from '@ifc-lite/ids/bridge';
import { convertServerDataModel } from '../src/utils/serverDataModel.js';

const [ifcPath, wirePath, materialName] = process.argv.slice(2);
if (!ifcPath || !wirePath || !materialName) {
  throw new Error('usage: probe-server-material-parity.ts <model.ifc> <data-model.parquet> <material name>');
}

const wire = readFileSync(wirePath);
const dataModel = await decodeDataModel(Uint8Array.from(wire).buffer);
const source = readFileSync(ifcPath);
const raw = await new IfcParser().parseColumnar(Uint8Array.from(source).buffer, { disableWorkerScan: true });
const server = convertServerDataModel(dataModel, {
  cache_key: 'material-parity',
  metadata: { schema_version: raw.schemaVersion },
  stats: { total_time_ms: 0, parse_time_ms: 0, geometry_time_ms: 0, total_vertices: 0, total_triangles: 0 },
}, { size: source.length }, []);
const rawAccessor = createDataAccessor(raw);
const serverAccessor = createDataAccessor(server);
const ids = [...new Set(dataModel.materials.filter((m) => m.material_name === materialName).map((m) => m.element_id))];
if (ids.length === 0) throw new Error(`no forwarded assignment for ${materialName}`);

for (const id of ids) {
  const names = (accessor: ReturnType<typeof createDataAccessor>) =>
    [...new Set(accessor.getMaterials(id).filter((m) => !m.unresolved).map((m) => m.name))].sort();
  const expected = names(rawAccessor);
  const actual = names(serverAccessor);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`#${id} material candidates differ: ${JSON.stringify({ expected, actual })}`);
  }
  console.log(JSON.stringify({ id, names: actual }));
}
console.log(`PASS: ${ids.length} elements matched raw-parser material candidates`);
