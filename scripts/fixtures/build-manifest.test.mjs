/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, 'build-manifest.mjs');
const VALIDATOR = join(HERE, 'manifest-validation.mjs');
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function reviewedEntry(path, bytes) {
  const digest = sha256(bytes);
  return {
    path,
    sha256: digest,
    size: bytes.length,
    provenance: {
      source: {
        blob_url: `https://github.com/example/fixtures/blob/${COMMIT}/${path}`,
        commit: COMMIT,
        sha256: digest,
        fetched_at: '2026-09-20',
      },
      license: {
        spdx: 'CC-BY-4.0',
        url: 'https://creativecommons.org/licenses/by/4.0/',
        attribution: 'Example author',
      },
      modification: { status: 'unmodified' },
      no_customer_data: true,
    },
    producer: { name: 'Example exporter', version: '1.0', export_settings: 'LandXML defaults' },
    landxml: {
      schema: 'LandXML 1.2',
      namespace: 'http://www.landxml.org/schema/LandXML-1.2',
      units: 'metric',
      crs: 'not-declared',
    },
    feature_inventory: [{ feature: 'alignment', expected_capability: 'preserved-only' }],
  };
}

function makeRoot(bytes) {
  const root = mkdtempSync(join(tmpdir(), 'fixbuild-'));
  const scriptsDir = join(root, 'scripts', 'fixtures');
  const modelsDir = join(root, 'tests', 'models');
  const path = 'landxml/road.xml';
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(modelsDir, 'landxml'), { recursive: true });
  copyFileSync(BUILD, join(scriptsDir, 'build-manifest.mjs'));
  copyFileSync(VALIDATOR, join(scriptsDir, 'manifest-validation.mjs'));
  writeFileSync(join(modelsDir, path), bytes);
  const entry = reviewedEntry(path, bytes);
  writeFileSync(
    join(modelsDir, 'manifest.json'),
    JSON.stringify({ version: 2, release_tag: 'fixtures-v2', base_url: 'https://example.invalid/fixtures', files: [entry] }),
  );
  return { root, path, entry };
}

function build(root) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'fixtures', 'build-manifest.mjs')], {
    encoding: 'utf8',
  });
}

test('v2 regeneration preserves reviewed LandXML provenance byte-for-byte', () => {
  const bytes = Buffer.from('<LandXML version="1.2"/>\n');
  const { root, entry } = makeRoot(bytes);
  try {
    const result = build(root);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const manifest = JSON.parse(readFileSync(join(root, 'tests', 'models', 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, 2);
    assert.deepEqual(manifest.files, [entry]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v2 regeneration refuses altered bytes until their provenance is reviewed', () => {
  const bytes = Buffer.from('<LandXML version="1.2"/>\n');
  const { root, path } = makeRoot(bytes);
  try {
    writeFileSync(join(root, 'tests', 'models', path), '<LandXML version="1.1"/>\n');
    const result = build(root);
    assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /refusing to add or alter landxml\/road\.xml/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
