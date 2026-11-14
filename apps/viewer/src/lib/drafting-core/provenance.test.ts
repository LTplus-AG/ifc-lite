/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The vendored drafting core is pinned to upstream bytes: every file that
 * provenance.json marks `adapted: false` must hash to its recorded sha256.
 * A local edit to a pinned file fails here; change it upstream and re-vendor,
 * or move it to `adapted: true` and own it. Offline: compares against the
 * committed manifest only (`scripts/check-drafting-drift.mjs` is the network
 * side, run by hand).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

interface ProvenanceFile {
  path: string;
  upstream: string;
  sha256: string;
  adapted: boolean;
}

interface Provenance {
  repository: string;
  commit: string;
  license: string;
  files: ProvenanceFile[];
}

const here = new URL('./', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('provenance.json', here), 'utf8')) as Provenance;

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(new URL(path, here))).digest('hex');
}

describe('drafting-core provenance', () => {
  it('names the upstream repository, a full commit and the MPL-2.0 licence', () => {
    assert.equal(manifest.repository, 'https://github.com/BIMvoice/ifc-sheet', 'upstream repository');
    // @source-text-assertion-ok checks a JSON manifest field (the pinned upstream commit), not source text
    assert.equal(/^[0-9a-f]{40}$/.test(manifest.commit), true, `commit ${manifest.commit} is a full sha`);
    assert.equal(manifest.license, 'MPL-2.0', 'licence');
  });

  it('pins every unadapted file to its recorded sha256', () => {
    const pinned = manifest.files.filter((f) => !f.adapted);
    assert.equal(pinned.length > 0, true, 'at least one byte-pinned file');
    for (const f of pinned) {
      const actual = sha256Of(f.path);
      assert.equal(actual === f.sha256, true, `${f.path}: sha256 ${actual} differs from pinned ${f.sha256}`);
    }
  });

  it('lists every module in the folder exactly once, each with an existing file', () => {
    const listed = manifest.files.map((f) => f.path).sort();
    assert.equal(new Set(listed).size === listed.length, true, `duplicate rows in ${listed.join(', ')}`);
    for (const p of listed) assert.equal(existsSync(new URL(p, here)), true, `${p} exists`);
    const modules = readdirSync(here)
      .filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))
      .sort();
    assert.equal(modules.join(','), listed.join(','), 'modules on disk match provenance.json rows');
  });
});
