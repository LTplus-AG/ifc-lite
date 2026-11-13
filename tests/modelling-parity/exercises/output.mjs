/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function resetExerciseOutputs(out) {
  for (const name of readdirSync(out)) {
    if (/\.(?:state|ifc|glb|json|jsonl|report|evidence)$/.test(name)) rmSync(join(out,name),{force:true});
  }
}

/** A state checkpoint certifies completion of both schema exports. */
export function publishExpectedState(out,state,exports) {
  const file=join(out,'expected.state');
  rmSync(file,{force:true});
  if (exports.length===2 && exports.every(done=>done===true)) writeFileSync(file,JSON.stringify(state));
}
