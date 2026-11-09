/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { MemoryReadFileSystem, readFile, materializeToDataTable, createChunkDataPool } from '@playcanvas/splat-transform';

// Offline oracle adapter only. Never imported by the viewer or canonical loader.
export async function decodeQualification(bytes, format) {
  const fs = new MemoryReadFileSystem();
  const filename = `qualification.${format}`;
  fs.set(filename, bytes);
  const pool = createChunkDataPool({ maxPooledBytes: 4 * 1024 * 1024 });
  let sources = [];
  try {
    sources = await readFile({ filename, inputFormat: format, fileSystem: fs });
    if (sources.length !== 1) throw new Error('expected one qualification source');
    return await materializeToDataTable(sources[0], pool);
  } finally {
    for (const source of sources) source.close();
    pool.destroy();
  }
}
