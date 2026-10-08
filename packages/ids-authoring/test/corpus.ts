/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test-only access to buildingSMART's IDS conformance corpus vendored in
 * `packages/ids/src/__corpus__/buildingsmart-ids` (CC BY-ND: read-only).
 *
 * Only `pass-` and `fail-` cases are returned: those are well-formed IDS
 * documents whose question is about a MODEL. `invalid-` cases are
 * deliberately malformed IDS and must not feed authoring tests.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIDS, type IDSDocument } from '@ifc-lite/ids';

const CORPUS_ROOT = fileURLToPath(new URL('../../ids/src/__corpus__/buildingsmart-ids/', import.meta.url));

export interface CorpusCase {
  /** `facet-dir/file.ids` */
  name: string;
  ids: IDSDocument;
  xml: string;
}

let cache: CorpusCase[] | undefined;

export function loadCorpus(): CorpusCase[] {
  if (cache) return cache;
  const out: CorpusCase[] = [];
  for (const dir of readdirSync(CORPUS_ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of readdirSync(join(CORPUS_ROOT, dir.name))) {
      if (!file.endsWith('.ids')) continue;
      if (!file.startsWith('pass-') && !file.startsWith('fail-')) continue;
      const xml = readFileSync(join(CORPUS_ROOT, dir.name, file), 'utf8');
      out.push({ name: `${dir.name}/${file}`, ids: parseIDS(xml), xml });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  if (out.length < 250) throw new Error(`corpus looks truncated: ${out.length} pass-/fail- files`);
  cache = out;
  return out;
}

/** Deterministic id source for tests: `00000000-0000-7000-8000-<counter>`. */
export function counterIds(prefix = 0): () => string {
  let n = 0;
  return () => {
    n += 1;
    const hex = n.toString(16).padStart(12, '0');
    return `${prefix.toString(16).padStart(8, '0')}-0000-7000-8000-${hex}`;
  };
}
