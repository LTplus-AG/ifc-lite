/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { assertReleaseHosted, uploadEntry, uploadFixtures, UploadRefused } from './upload-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const UPLOAD = join(HERE, 'upload-fixtures.mjs');
const VALIDATOR = join(HERE, 'manifest-validation.mjs');
const DOWNLOAD_URL = join(HERE, 'download-url.mjs');

test('uploader refuses an unreviewed v2 fixture before invoking GitHub', () => {
  const root = mkdtempSync(join(tmpdir(), 'fixupload-'));
  const scriptsDir = join(root, 'scripts', 'fixtures');
  const modelsDir = join(root, 'tests', 'models');
  try {
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(modelsDir, { recursive: true });
    copyFileSync(UPLOAD, join(scriptsDir, 'upload-fixtures.mjs'));
    copyFileSync(VALIDATOR, join(scriptsDir, 'manifest-validation.mjs'));
    copyFileSync(DOWNLOAD_URL, join(scriptsDir, 'download-url.mjs'));
    writeFileSync(
      join(modelsDir, 'manifest.json'),
      JSON.stringify({
        version: 2,
        release_tag: 'fixtures-v2',
        base_url: 'https://example.invalid/fixtures',
        files: [{ path: 'landxml/unreviewed.xml', sha256: '0'.repeat(64), size: 1 }],
      }),
    );
    const result = spawnSync(process.execPath, [join(scriptsDir, 'upload-fixtures.mjs')], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /files\[0\]\.provenance: is required for a reviewed LandXML fixture/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uploader excludes a source-hosted IFC even when its bytes are absent locally', () => {
  const root = mkdtempSync(join(tmpdir(), 'fixupload-upstream-'));
  const scriptsDir = join(root, 'scripts', 'fixtures');
  const modelsDir = join(root, 'tests', 'models');
  try {
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(modelsDir, { recursive: true });
    copyFileSync(UPLOAD, join(scriptsDir, 'upload-fixtures.mjs'));
    copyFileSync(VALIDATOR, join(scriptsDir, 'manifest-validation.mjs'));
    copyFileSync(DOWNLOAD_URL, join(scriptsDir, 'download-url.mjs'));
    const commit = '0123456789abcdef0123456789abcdef01234567';
    writeFileSync(join(modelsDir, 'manifest.json'), JSON.stringify({
      version: 1,
      release_tag: 'fixtures-v1',
      base_url: 'https://example.invalid/fixtures',
      files: [{
        path: 'buildingsmart/bridge.ifc', sha256: 'a'.repeat(64), size: 32,
        upstream_archive: {
          blob_url: `https://github.com/example/models/blob/${commit}/bridge.zip`,
          commit, sha256: 'b'.repeat(64), size: 128, member: 'bridge.ifc',
        },
      }],
    }));
    const result = spawnSync(process.execPath, [join(scriptsDir, 'upload-fixtures.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /No release-hosted fixtures to upload/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Follow-up to #5942: `pnpm fixtures:upload` published eight reviewed LandXML
// rows to the public release although the fetcher takes them from their pinned
// upstream blob. Every test below drives the uploader against a fake manifest
// and a stub release client; nothing calls GitHub.
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function reviewedLandXml(path, bytes) {
  const hash = sha256(bytes);
  return {
    path, sha256: hash, size: bytes.length,
    provenance: {
      source: {
        blob_url: `https://github.com/example/producer/blob/${COMMIT}/exports/${path.split('/').pop()}`,
        commit: COMMIT, sha256: hash, fetched_at: '2026-09-20',
      },
      license: { spdx: 'CC-BY-4.0', url: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'example' },
      modification: { status: 'unmodified' },
      no_customer_data: true,
    },
    producer: { name: 'Example', version: '1', export_settings: 'LandXML 1.2' },
    landxml: { schema: 'LandXML 1.2', namespace: 'http://www.landxml.org/schema/LandXML-1.2', units: 'metre', crs: 'EPSG:2056' },
    feature_inventory: [{ feature: 'TIN', expected_capability: 'rendered' }],
  };
}

function stubRelease() {
  const uploads = [];
  return {
    uploads,
    tag: 'fixtures-v1',
    exists: () => true,
    create: () => assert.fail('the release exists; create() must not run'),
    listAssets: () => [],
    upload: (stagedPath) => { uploads.push(stagedPath.split(/[\\/]/).pop()); },
  };
}

function corpus(files) {
  const modelsDir = mkdtempSync(join(tmpdir(), 'fixupload-corpus-'));
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(modelsDir, path)), { recursive: true });
    writeFileSync(join(modelsDir, path), bytes);
  }
  return modelsDir;
}

test('uploader skips reviewed LandXML rows the fetcher takes from upstream (#5942)', async () => {
  const ifc = Buffer.from('ISO-10303-21; release-hosted');
  const upstreamXml = Buffer.from('<LandXML>upstream</LandXML>');
  const modelsDir = corpus({ 'a.ifc': ifc, 'landxml/producers/real.xml': upstreamXml });
  try {
    const manifest = {
      version: 1, release_tag: 'fixtures-v1', base_url: 'https://example.invalid/fixtures',
      files: [
        { path: 'a.ifc', sha256: sha256(ifc), size: ifc.length },
        reviewedLandXml('landxml/producers/real.xml', upstreamXml),
      ],
    };
    const release = stubRelease();
    const result = await uploadFixtures(manifest, { modelsDir, release });
    assert.deepEqual(release.uploads, [sha256(ifc)]);
    assert.equal(result.uploaded, 1);
    assert.deepEqual(result.failed, []);
  } finally {
    rmSync(modelsDir, { recursive: true, force: true });
  }
});

test('uploader refuses, by name, to publish a file whose entry is fetched upstream (#5942)', async () => {
  const bytes = Buffer.from('<LandXML>upstream</LandXML>');
  const modelsDir = corpus({ 'landxml/producers/real.xml': bytes });
  const stagingDir = mkdtempSync(join(tmpdir(), 'fixupload-staging-'));
  try {
    const entry = reviewedLandXml('landxml/producers/real.xml', bytes);
    const release = stubRelease();
    const refusal = /refusing to upload landxml\/producers\/real\.xml: its manifest entry is fetched from its pinned upstream source \(https:\/\/github\.com\/example\/producer\/blob\//;
    assert.throws(() => assertReleaseHosted(entry), (err) => err instanceof UploadRefused && refusal.test(err.message));
    await assert.rejects(uploadEntry(entry, { modelsDir, stagingDir, release }), refusal);
    assert.deepEqual(release.uploads, [], 'the release client must never see an upstream-fetched file');
  } finally {
    rmSync(modelsDir, { recursive: true, force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  }
});

test('a modified LandXML row is release-hosted, so the uploader still publishes it', async () => {
  const bytes = Buffer.from('<LandXML>relabelled envelope</LandXML>');
  const modelsDir = corpus({ 'landxml/producers/relabelled.xml': bytes });
  try {
    const entry = reviewedLandXml('landxml/producers/relabelled.xml', bytes);
    entry.provenance.modification = { status: 'modified', description: 'envelope relabelled' };
    entry.provenance.source.sha256 = 'c'.repeat(64);
    const manifest = { version: 1, release_tag: 'fixtures-v1', base_url: 'https://example.invalid/fixtures', files: [entry] };
    const release = stubRelease();
    await uploadFixtures(manifest, { modelsDir, release });
    assert.deepEqual(release.uploads, [sha256(bytes)]);
  } finally {
    rmSync(modelsDir, { recursive: true, force: true });
  }
});
