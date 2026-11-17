/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SHOWCASE_SUBJECTS, showcaseCredits } from '../showcase-credits.mjs';

const manifest = JSON.parse(await readFile(new URL('../../../tests/models/manifest.json', import.meta.url), 'utf8'));
const entryFor = path => manifest.files.find(file => file.path === path);

test('every showcase credit agrees with its catalogued licence record (#8567)', () => {
  for (const path of Object.keys(SHOWCASE_SUBJECTS)) {
    const entry = entryFor(path);
    assert.ok(entry, `${path} must be catalogued`);
    const credits = showcaseCredits(entry);
    assert.equal(entry.provenance.license.spdx, 'CC-BY-4.0');
    assert.match(credits.credit, /CC BY 4\.0/);
    assert.ok(credits.credit.includes(new URL(entry.provenance.source.page_url).host), 'credit names the source host');
    assert.ok(credits.change.includes('creativecommons.org/licenses/by/4.0'), 'credit links the licence');
    assert.equal(/converted/i.test(credits.change), entry.provenance.modification.status === 'modified');
  }
});

test('credits refuse captures whose licence record cannot carry them (#8567)', () => {
  const church = entryFor('gaussian/seem-kirke-v1.ply');
  const clone = () => structuredClone(church);
  assert.throws(() => showcaseCredits({ ...clone(), path: 'gaussian/plant.splat' }), /no showcase credit/);
  const unlicensed = clone(); unlicensed.provenance.license.spdx = 'LicenseRef-unknown';
  assert.throws(() => showcaseCredits(unlicensed), /licence record/);
  const otherAuthor = clone(); otherAuthor.provenance.license.attribution = 'Someone else, CC BY 4.0';
  assert.throws(() => showcaseCredits(otherAuthor), /licence record/);
  const unmodified = clone(); unmodified.provenance.modification.status = 'unmodified';
  assert.throws(() => showcaseCredits(unmodified), /modification note/);
});
