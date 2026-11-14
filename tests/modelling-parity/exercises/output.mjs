/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function resetExerciseOutputs(out) {
  const generated=['expected.state','progress.state','author.jsonl','results.jsonl','results.json',
    'blank.ifc','before.glb','model.glb','bounds.evidence',
    ...['IFC4','IFC2X3'].flatMap(schema=>[`${schema}.ifc`,`${schema}.validation.report`,`${schema}.levels.state`])];
  for (const name of generated) rmSync(join(out,name),{force:true});
}

/** A state checkpoint certifies completion of both schema exports. */
export function publishExpectedState(out,state,exports) {
  const file=join(out,'expected.state');
  rmSync(file,{force:true});
  if (exports.length===2 && exports.every(done=>done===true)) writeFileSync(file,JSON.stringify(state));
}
