/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { withModelFile, doorRows } from './common.mjs';

await withModelFile(process.argv[2] ?? 'model.ifc', model => {
  console.log(JSON.stringify({ schema: model.store.schemaVersion, doors: doorRows(model) }, null, 2));
});
