/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { GeometryProcessor } from '../../../packages/geometry/dist/index.js';
import { readFileSync, writeFileSync } from 'node:fs';
const gp=new GeometryProcessor();
try {
  await gp.init();
  const bytes=gp.exportGlb(readFileSync(process.argv[2]),true,new Uint32Array(),undefined,'',true,false);
  if(!bytes) throw new Error('GLB export returned no bytes');
  writeFileSync(process.argv[3],bytes);
} finally { gp.dispose(); }
