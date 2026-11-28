/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMeasuredFile } from '../perf-ratchet/ceilings.mjs';

/** Largest measured file read from an artifact; real ones are a few KB. */
export const MEASURED_FILE_MAX_BYTES = 1024 * 1024;

/**
 * The `.json` files an unzipped artifact holds, each a regular file under the
 * size cap. A PR run (a fork's included) uploads these artifacts itself, so a
 * symlink (to /dev/zero, or to a file on the runner) or a huge file is refused
 * instead of followed: the throw makes that PR's verdict `unknown`.
 */
export function measuredJsonFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const path = join(dir, name);
    const st = lstatSync(path);
    if (!st.isFile()) throw new Error(`artifact file ${name} is not a regular file`);
    if (st.size > MEASURED_FILE_MAX_BYTES) throw new Error(`artifact file ${name} is ${st.size} bytes, over the ${MEASURED_FILE_MAX_BYTES} cap`);
    files.push(path);
  }
  return files;
}

export function readArtifactFamily({ spawn, repo, art, name, runId, dir, family }) {
  const zip = spawn('gh', ['api', `repos/${repo}/actions/artifacts/${art.id}/zip`], { maxBuffer: 64 * 1024 * 1024 });
  if (zip.status !== 0) throw new Error(`downloading artifact ${name} of run ${runId} failed: ${String(zip.stderr).trim()}`);
  const out = join(dir, name);
  mkdirSync(out);
  writeFileSync(join(dir, `${name}.zip`), zip.stdout);
  execFileSync('unzip', ['-q', '-o', join(dir, `${name}.zip`), '-d', out]);
  return measuredJsonFiles(out).map(loadMeasuredFile).filter((m) => m.family === family);
}
