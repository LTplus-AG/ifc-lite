/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import { parseIDS, validateIDS } from '@ifc-lite/ids';
import { createDataAccessor } from '@ifc-lite/ids/bridge';
import { withModelFile } from './common.mjs';

const ids = parseIDS(await readFile(process.argv[3] ?? 'requirements.ids', 'utf8'));
await withModelFile(process.argv[2] ?? 'model.ifc', async model => {
  const report = await validateIDS(ids, createDataAccessor(model.store), {
    modelId: model.bim.model.list()[0].id,
    schemaVersion: model.store.schemaVersion,
    entityCount: model.store.entityCount,
  });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.summary.failedSpecifications > 0 ? 1 : report.summary.totalEntitiesChecked === 0 ? 2 : 0;
});
