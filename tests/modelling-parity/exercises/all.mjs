/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { run } from './run.mjs';
import { writeFileSync } from 'node:fs';
const results=[];
for(const id of ['F1','F2','F3','F4','F5','F6']) {
  if(id==='F5') results.push(...await run(id,['--floors','10']));
  results.push(...await run(id,[]));
}
if(process.env.PARITY_BASELINE) writeFileSync(process.env.PARITY_BASELINE,'[\n'+results.map(r=>JSON.stringify(r)).join(',\n')+'\n]\n');
