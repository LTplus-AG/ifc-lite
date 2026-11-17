/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one parser of scripts/wasm-build-inputs.txt, shared by the WASM build
 * cache key (scripts/ci-wasm-cache.mjs) and, through its `published-paths`
 * subcommand, the prebuilt-eligibility probes.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const INPUTS_FILE = 'scripts/wasm-build-inputs.txt';
const CACHE_ONLY = 'cache-only:';

/**
 * Entries of the input list. A `cache-only:` entry feeds only outputs the
 * published npm bundle does not contain (the probe bundle, opt-in bundles),
 * so it keys the cache but not the prebuilt-eligibility probes.
 */
export function parseInputEntries(text) {
  const entries = [];
  for (const raw of text.split('\n')) {
    let line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const cacheOnly = line.startsWith(CACHE_ONLY);
    if (cacheOnly) line = line.slice(CACHE_ONLY.length);
    if (!line || /\s/.test(line) || line.startsWith('/') || line.split('/').includes('..')) {
      throw new Error(`${INPUTS_FILE}: '${raw.trim()}' is not a repo-relative path`);
    }
    entries.push({ path: line, cacheOnly });
  }
  if (entries.length === 0) throw new Error(`${INPUTS_FILE} lists no paths`);
  return entries;
}

/** Every listed path, or with `published` only those the npm bundle depends on. */
export function readInputList(cwd, { published = false } = {}) {
  const entries = parseInputEntries(readFileSync(join(cwd, INPUTS_FILE), 'utf-8'));
  const paths = entries.filter((entry) => !(published && entry.cacheOnly)).map((entry) => entry.path);
  if (paths.length === 0) throw new Error(`${INPUTS_FILE} lists no path the published bundle depends on`);
  return paths;
}
