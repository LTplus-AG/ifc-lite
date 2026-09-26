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

const HERE = dirname(fileURLToPath(import.meta.url));
const UPLOAD = join(HERE, 'upload-fixtures.mjs');
const VALIDATOR = join(HERE, 'manifest-validation.mjs');

test('uploader refuses an unreviewed v2 fixture before invoking GitHub', () => {
  const root = mkdtempSync(join(tmpdir(), 'fixupload-'));
  const scriptsDir = join(root, 'scripts', 'fixtures');
  const modelsDir = join(root, 'tests', 'models');
  try {
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(modelsDir, { recursive: true });
    copyFileSync(UPLOAD, join(scriptsDir, 'upload-fixtures.mjs'));
    copyFileSync(VALIDATOR, join(scriptsDir, 'manifest-validation.mjs'));
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
