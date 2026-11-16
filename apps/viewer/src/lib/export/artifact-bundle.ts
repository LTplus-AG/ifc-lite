/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { zip, strToU8 } from 'fflate';
import type { ArtifactFile } from './model-changes';

/** Bundle produced files into a zip off the main thread (fflate async `zip`). */
export function zipArtifacts(files: ArtifactFile[]): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) {
    entries[`${f.base}.${f.ext}`] = typeof f.content === 'string' ? strToU8(f.content) : f.content;
  }
  return new Promise((resolve, reject) => {
    zip(entries, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}
