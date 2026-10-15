/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile, writeFile } from 'node:fs/promises';
import { Console } from 'node:console';

// This standalone process reserves stdout for its machine-readable result.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
const { GeometryProcessor } = await import('@ifc-lite/geometry');

const bytes = await readFile(process.argv[2] ?? 'model.ifc');
const processor = new GeometryProcessor({ enableInstancing: false });
try {
  await processor.init();
  const result = await processor.process(bytes);
  const glb = processor.exportGlbFromMeshes(result.meshes);
  if (!glb) throw new Error('The geometry runtime did not produce a GLB');
  const output = process.argv[3] ?? 'model.glb';
  await writeFile(output, glb);
  process.stdout.write(`${JSON.stringify({ output, meshes: result.meshes.length, coordinateInfo: result.coordinateInfo })}\n`);
} finally { processor.dispose(); }
