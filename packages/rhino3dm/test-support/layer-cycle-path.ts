/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { loadRhino } from '../src/runtime.js';

/**
 * Reads the native `Layer.fullPath` of a layer whose parent chain is a cycle, and prints what it
 * answers. Run as a child process with a deadline (see `document.test.ts`): in rhino3dm 8.35.0 the
 * call does not come back, so the parent kills it. The cycle is built in the model rather than in
 * a .3dm, because openNURBS resets a cyclic parent to nil when it writes the archive.
 */
const rhino = await loadRhino();
const file = new rhino.File3dm(), layers = file.layers();
const parent = new rhino.Layer(), child = new rhino.Layer();
parent.name = 'Parent'; child.name = 'Child';
const top = layers.add(parent);
child.parentLayerId = layers.get(top).id;
const nested = layers.add(child);
// Through the table wrapper, which reaches the model component itself.
layers.get(top).parentLayerId = layers.get(nested).id;
console.log(`cycle built: ${layers.get(top).parentLayerId === layers.get(nested).id}`);
console.log(`full path: ${layers.get(top).fullPath}`);
