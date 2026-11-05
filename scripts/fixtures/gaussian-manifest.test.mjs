/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateManifest } from './manifest-validation.mjs';
const catalogue = JSON.parse(readFileSync(new URL('../../tests/models/manifest.json', import.meta.url), 'utf8'));
const source = catalogue.files.find(entry => entry.gaussian);

test('public Gaussian metadata is required even in a historical v1 catalogue (#8567)', () => {
  assert.ok(source);
  assert.deepEqual(validateManifest({ version: 1, files: [source] }), []);
  for (const mutate of [
    entry => delete entry.provenance,
    entry => delete entry.provenance.license,
    entry => { entry.provenance.source.blob_url = entry.provenance.source.blob_url.replace(entry.provenance.source.commit, 'main'); },
    entry => { entry.sha256 = 'a'.repeat(64); },
    entry => { entry.gaussian.sh_degree = 3; },
    entry => { entry.gaussian.count++; },
    entry => delete entry.gaussian.units,
  ]) {
    const entry = structuredClone(source); mutate(entry);
    assert.notDeepEqual(validateManifest({ version: 1, files: [entry] }), []);
  }
});

test('ordinary PLY retains historical manifest acceptance (#8580)', () => {
  assert.deepEqual(validateManifest({ version: 1, files: [
    { path: 'pointcloud/ordinary.ply', size: 123, sha256: 'a'.repeat(64) },
  ] }), []);
});

test('reserved Gaussian paths require provenance even after deleting classification metadata (#8580)', () => {
  for (const path of ['gaussian/control.ply', 'gaussian/nested/control.PLY', 'elsewhere/control.splat']) {
    const entry = { ...structuredClone(source), path };
    assert.deepEqual(validateManifest({ version: 1, files: [entry] }), []);
    delete entry.gaussian;
    delete entry.provenance;
    const errors = validateManifest({ version: 1, files: [entry] });
    assert.ok(errors.some(error => error.includes('provenance')));
    assert.ok(errors.some(error => error.includes('Gaussian metadata')));
  }
  const misplaced = { ...structuredClone(source), path: 'pointcloud/misplaced.ply' };
  assert.ok(validateManifest({ version: 1, files: [misplaced] }).some(error => error.includes('reserved gaussian/')));
});

test('noncanonical paths cannot bypass Gaussian provenance (#8580)', () => {
  // Also verify the full historical catalogue remains admissible.
  assert.deepEqual(validateManifest(catalogue), []);
  for (const path of ['./gaussian/control.ply', 'pointcloud/../gaussian/control.ply',
    'gaussian//control.ply', '/gaussian/control.ply', 'gaussian/./control.ply',
    'gaussian\\control.ply', 'C:/gaussian/control.ply']) {
    const errors = validateManifest({ version: 1, files: [{ path, size: 123, sha256: 'a'.repeat(64) }] });
    assert.ok(errors.some(error => error.includes('canonical relative POSIX path')), path);
  }
});

test('publisher Gaussian artifacts retain hash provenance and release hosting (#8567)', async () => {
  const { fixtureDownloadUrl } = await import('./download-url.mjs');
  const entry = structuredClone(source);
  entry.provenance.source = {
    kind: 'publisher-artifacts', page_url: 'https://example.org/scene', version: 'v1',
    sha256: entry.sha256, fetched_at: '2026-11-02',
    artifacts: [{ path: 'capture.splat', url: 'https://example.org/v1/capture.splat', size: entry.size, sha256: entry.sha256 }],
  };
  entry.provenance.license.evidence_url = 'https://example.org/license';
  entry.provenance.license.evidence_sha256 = 'a'.repeat(64);
  assert.deepEqual(validateManifest({ version: 1, files: [entry] }), []);
  assert.equal(fixtureDownloadUrl('https://release.example', entry), `https://release.example/${entry.sha256}`);
  for (const mutate of [
    e => delete e.provenance.source.artifacts,
    e => { e.provenance.source.artifacts[0].sha256 = 'not-a-hash'; },
    e => { e.provenance.source.artifacts[0].size = -1; },
    e => { e.provenance.source.artifacts[0].path = '../capture.splat'; },
    e => { e.provenance.source.artifacts.push(e.provenance.source.artifacts[0]); },
    e => { e.provenance.source.artifacts[0].url = 'http://example.org/capture'; },
    e => { e.provenance.source.sha256 = 'b'.repeat(64); },
    e => { e.provenance.source.commit = 'b'.repeat(40); },
    e => delete e.provenance.license.evidence_sha256,
  ]) {
    const invalid = structuredClone(entry); mutate(invalid);
    assert.notDeepEqual(validateManifest({ version: 1, files: [invalid] }), []);
  }
  const landxml = { ...entry, path: 'landxml/capture.xml' };
  assert.ok(validateManifest({ version: 1, files: [landxml] }).some(e => e.includes('commit')),
    'publisher source does not relax LandXML Git provenance');
});

test('the release corpus carries a public metric IFC/scan/splat triple and a pinned batch witness (#8567)', () => {
  const byPath = new Map(catalogue.files.map(entry => [entry.path, entry]));
  const triple = ['edinburgh/model.ifc', 'edinburgh/cloud_coloured.e57', 'edinburgh/scan-vox12mm.laz', 'gaussian/edinburgh-scan-sh3.ply'];
  for (const path of triple) {
    const entry = byPath.get(path);
    assert.ok(entry, `${path} is in the corpus`);
    assert.equal(entry.provenance?.license, 'CC-BY-4.0', `${path} is publicly licensed`);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${path} is hash-pinned`);
    assert.ok(entry.size > 0, `${path} has a pinned size`);
  }
  // Metric co-registration is measured, not assumed: the splat must sit on the
  // scan, and the scan on the IFC, at centimetre scale in one shared frame.
  const alignment = byPath.get('gaussian/edinburgh-scan-sh3.ply').alignment;
  assert.ok(alignment.scan_to_ifc_wall_slab_band_median_m < 0.05, 'scan lies on the IFC walls and slabs');
  assert.ok(alignment.scan_to_nearest_splat_center_median_m < 0.05, 'splat centres lie on the scan');
  assert.ok(alignment.ifc_scan_aabb_iou > 0.8, 'IFC and scan share one frame');
  const witness = byPath.get('gaussian/qualification-32-batch-sh3.ply');
  assert.ok(witness, 'the interleaved-batch witness is in the corpus');
  assert.match(witness.sha256, /^[0-9a-f]{64}$/);
  assert.equal(witness.gaussian.sh_degree, 3);
  assert.deepEqual(validateManifest({ version: catalogue.version, files: [...triple.map(path => byPath.get(path)), witness] }), []);
});
