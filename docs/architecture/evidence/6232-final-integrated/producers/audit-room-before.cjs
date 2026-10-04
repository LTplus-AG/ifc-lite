// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const assert = require('node:assert/strict');
const { metadataGraph } = require('./metadata-graph.cjs');
const receipt = JSON.parse(gunzipSync(fs.readFileSync(path.join(__dirname, '../room-before-failed.json.gz'))));
const target = stage => receipt.proofs.find(proof => proof.stage === stage).models.find(model => model.modelId === receipt.modelId);
const sourceIds = target('baseline').graph.map(row => row.id);
const canonical = model => metadataGraph(model.graph, new Set([...sourceIds, ...model.records.map(row => row.expressId)]));
const before = canonical(target('room-pick')), after = canonical(target('room-cut-undo'));
const differences = before.flatMap((row, index) => JSON.stringify(row) === JSON.stringify(after[index]) ? [] : [{ before: row, after: after[index] }]);
assert.equal(differences.length, 3);
assert.deepEqual(differences.map(row => [row.before.type, row.after.type]), [
  ['IFCQUANTITYAREA', 'IFCQUANTITYCOUNT'], ['IFCQUANTITYAREA', 'IFCQUANTITYCOUNT'], ['IFCQUANTITYVOLUME', 'IFCQUANTITYCOUNT'],
]);
console.log(JSON.stringify({ observed: 'Synthetic identity normalization retains all three substantive quantity-type failures', differences }, null, 2));
