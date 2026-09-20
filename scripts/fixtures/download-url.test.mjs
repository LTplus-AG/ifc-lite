/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureDownloadUrl } from './download-url.mjs';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const SHA256 = 'a'.repeat(64);
const BASE_URL = 'https://fixtures.example.invalid/release';

function reviewedEntry(overrides = {}) {
  return {
    path: 'landxml/producers/example.xml',
    sha256: SHA256,
    provenance: {
      source: {
        sha256: SHA256,
        blob_url: `https://github.com/example/producer/blob/${COMMIT}/exports/example.xml`,
      },
      modification: { status: 'unmodified' },
    },
    ...overrides,
  };
}

test('reviewed, unmodified LandXML fixtures fetch their commit-pinned source bytes', () => {
  assert.equal(
    fixtureDownloadUrl(BASE_URL, reviewedEntry()),
    `https://raw.githubusercontent.com/example/producer/${COMMIT}/exports/example.xml`,
  );
});

test('modified, unhashed, and non-LandXML fixtures stay on the content-addressed release', () => {
  const modified = reviewedEntry();
  modified.provenance.modification.status = 'modified';
  assert.equal(
    fixtureDownloadUrl(BASE_URL, modified),
    `${BASE_URL}/${SHA256}`,
  );
  assert.equal(
    fixtureDownloadUrl(BASE_URL, reviewedEntry({ sha256: 'b'.repeat(64) })),
    `${BASE_URL}/${'b'.repeat(64)}`,
  );
  assert.equal(
    fixtureDownloadUrl(BASE_URL, reviewedEntry({ path: 'producer/example.ifc' })),
    `${BASE_URL}/${SHA256}`,
  );
});
