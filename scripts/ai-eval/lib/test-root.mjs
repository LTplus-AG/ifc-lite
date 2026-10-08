/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Test support (#6928): a scratch copy of the evaluation tree that the gates can be pointed at with `--root`. */

import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './recording.mjs';

/** A throwaway root holding tests/ai-eval, the model catalogue and the committed samples. */
export function cloneRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ai-eval-'));
  cpSync(join(REPO_ROOT, 'tests', 'ai-eval'), join(root, 'tests', 'ai-eval'), { recursive: true });
  mkdirSync(join(root, 'tests', 'models'), { recursive: true });
  cpSync(join(REPO_ROOT, 'tests', 'models', 'manifest.json'), join(root, 'tests', 'models', 'manifest.json'));
  cpSync(join(REPO_ROOT, 'apps', 'viewer', 'public', 'samples'), join(root, 'apps', 'viewer', 'public', 'samples'), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

/** Rewrite one recording in a cloned root. */
export function editRecording(root, name, edit) {
  const path = join(root, 'tests', 'ai-eval', 'recordings', `${name}.json`);
  const value = readJson(path);
  writeJson(path, edit(value) ?? value);
}

export const recordingNames = root => readdirSync(join(root, 'tests', 'ai-eval', 'recordings')).map(name => name.replace(/\.json$/, ''));
