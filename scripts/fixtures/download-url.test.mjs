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

test('reviewed Gaussian corpus uses immutable upstream bytes (#8567)', () => {
  for (const extension of ['ply', 'splat']) {
    assert.equal(fixtureDownloadUrl(BASE_URL, reviewedEntry({ path: `gaussian/capture.${extension}` })),
      `https://raw.githubusercontent.com/example/producer/${COMMIT}/exports/example.xml`);
  }
});

test('ordinary PLY keeps release URL even when carrying matching immutable provenance (#8580)', () => {
  const entry = reviewedEntry({ path: 'pointcloud/ordinary.ply' });
  assert.equal(fixtureDownloadUrl(BASE_URL, entry), `${BASE_URL}/${SHA256}`);
  // The reserved path, not the optional Gaussian metadata object, selects policy.
  entry.path = 'gaussian/nested/control.ply';
  assert.equal(fixtureDownloadUrl(BASE_URL, entry),
    `https://raw.githubusercontent.com/example/producer/${COMMIT}/exports/example.xml`);
  entry.provenance.modification.status = 'modified';
  assert.equal(fixtureDownloadUrl(BASE_URL, entry), `${BASE_URL}/${SHA256}`);
});

test('URL policy rejects noncanonical aliases before selecting either source (#8580)', () => {
  for (const path of ['./gaussian/control.ply', 'pointcloud/../gaussian/control.ply']) {
    const entry = reviewedEntry({ path });
    assert.throws(() => fixtureDownloadUrl(BASE_URL, entry), /canonical relative POSIX path/);
    delete entry.provenance;
    assert.throws(() => fixtureDownloadUrl(BASE_URL, entry), /canonical relative POSIX path/);
  }
});
