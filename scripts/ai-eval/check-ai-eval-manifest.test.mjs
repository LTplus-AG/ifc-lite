/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './check-ai-eval-manifest.mjs';
import { privacyFindings, sha256 } from './lib/manifest.mjs';
import { REPO_ROOT } from './lib/recording.mjs';
import { cloneRoot, editRecording, readJson, writeJson } from './lib/test-root.mjs';

const withRoot = async fn => { const { root, cleanup } = cloneRoot(); try { await fn(root); } finally { cleanup(); } };
const manifestPath = root => join(root, 'tests', 'ai-eval', 'manifest.json');
const sample = root => join(root, 'apps', 'viewer', 'public', 'samples', 'building-architecture.ifc');

test('the committed manifest and recordings pass, with stated gaps as notes', () => {
  const { errors, notes } = run(REPO_ROOT);
  assert.deepEqual(errors, []);
  assert.ok(notes.some(note => /await human privacy review/.test(note)), 'pending human review is stated, not hidden');
});

test('a changed fixture byte is caught by the recomputed fingerprint', () => withRoot(root => {
  appendFileSync(sample(root), '\n');
  assert.ok(run(root).errors.some(error => /fixture sample-architecture: .*sha256/.test(error)));
}));

test('an e-mail address or credential in a fixture fails the privacy scan', () => withRoot(root => {
  appendFileSync(sample(root), '/* contact someone@example.com */\n');
  assert.ok(run(root).errors.some(error => /privacy scan: e-mail address someone@example.com/.test(error)));
}));

test('privacyFindings: STEP author/organisation must be empty; credential-like tokens are refused', () => {
  const header = (author, org) => `ISO-10303-21;\nHEADER;\nFILE_NAME('a.ifc','2024-01-01',${author},${org},'x','y','');\n`;
  assert.deepEqual(privacyFindings(header("('')", "('')"), 'ifc'), []);
  assert.deepEqual(privacyFindings(header('$', '$'), 'ifc'), []);
  assert.match(privacyFindings(header("('Jane Doe')", '$'), 'ifc')[0], /author\/organisation present/);
  assert.match(privacyFindings('token sk-ant-abcdefghijklmnopqrstuv', 'ifc').join(), /credential-like/);
  assert.match(privacyFindings('no header here', 'ifc').join(), /FILE_NAME/);
});

test('a task naming an unknown scene, journey or invariant is refused', () => withRoot(root => {
  const manifest = readJson(manifestPath(root));
  manifest.tasks[0].scene = 'nowhere';
  manifest.tasks[0].journey = 'nothing';
  manifest.tasks[0].invariants.push('made-up');
  writeJson(manifestPath(root), manifest);
  const { errors } = run(root);
  for (const part of [/unknown scene nowhere/, /unknown journey nothing/, /unknown invariant made-up/]) assert.ok(errors.some(error => part.test(error)), `${part} in ${errors}`);
}));

test('a native result must be pinned to the bytes of the model it came from', () => withRoot(root => {
  const path = join(root, 'tests', 'ai-eval', 'native', 'clash-rev-b-clearance.json');
  const result = readJson(path);
  result.provenance.sha256 = '0'.repeat(64);
  writeJson(path, result);
  const { errors } = run(root);
  assert.ok(errors.some(error => /provenance must name its derivedFrom/.test(error)), errors.join('\n'));
}));

test('a recording must match its task scene and evidence source', () => withRoot(root => {
  editRecording(root, 'clash-summary-release', recording => { recording.scene = 'flow-empty'; recording.evidence.source = 'flow'; });
  const { errors } = run(root);
  assert.ok(errors.some(error => /scene flow-empty differs from task scene clash-rev-b/.test(error)));
  assert.ok(errors.some(error => /evidence source differs/.test(error)));
}));

test('release recordings tolerate no violations and negative ones must name theirs', () => withRoot(root => {
  editRecording(root, 'clash-summary-release', recording => { recording.expect.violations = ['no-effect-claims']; });
  editRecording(root, 'clash-summary-bad-citation-negative', recording => { recording.expect.violations = []; });
  const { errors } = run(root);
  assert.ok(errors.some(error => /release recordings tolerate no violations/.test(error)));
  assert.ok(errors.some(error => /negative recording must name the invariant/.test(error)));
}));

test('an unknown schema keyword or a missing recordings folder cannot pass silently', () => withRoot(root => {
  const schemaPath = join(root, 'tests', 'ai-eval', 'manifest.schema.json');
  const schema = readJson(schemaPath);
  schema.properties.version.format = 'x';
  writeJson(schemaPath, schema);
  assert.throws(() => run(root), /format/);
}));

test('an unfetched fixture-mechanism model is a stated note, not an error or a pass', () => withRoot(root => {
  const { errors, notes } = run(root);
  assert.deepEqual(errors, []);
  assert.ok(notes.some(note => /fzk-haus: not fetched/.test(note)));
  writeFileSync(join(root, 'tests', 'ai-eval', 'recordings', 'junk.json'), '{}');
  assert.ok(run(root).errors.length > 0, 'an invalid recording file is an error');
}));

const header = (author, organisation) => `ISO-10303-21;\nHEADER;\nFILE_NAME('a.ifc','2016-12-21T17:54:06',${author},${organisation},'x','y','z');\nENDSEC;\n`;

/** A root with a fetched fixture (origin "fixtures") and the supplied STEP header, as on CI after pnpm fixtures. */
function withFetchedFixture(author, organisation, fn) {
  return withRoot(root => {
    const body = header(author, organisation);
    const path = join(root, 'tests', 'models', 'ara3d', 'AC20-FZK-Haus.ifc');
    mkdirSync(join(root, 'tests', 'models', 'ara3d'), { recursive: true });
    writeFileSync(path, body);
    const catalogue = readJson(join(root, 'tests', 'models', 'manifest.json'));
    const entry = catalogue.files.find(file => file.path === 'ara3d/AC20-FZK-Haus.ifc');
    Object.assign(entry, { sha256: sha256(Buffer.from(body)), size: Buffer.byteLength(body) });
    writeJson(join(root, 'tests', 'models', 'manifest.json'), catalogue);
    const manifest = readJson(manifestPath(root));
    const fixture = manifest.fixtures.find(item => item.id === 'fzk-haus');
    Object.assign(fixture, { sha256: entry.sha256, size: entry.size });
    writeJson(manifestPath(root), manifest);
    return fn(root);
  });
}

// #6928 / #7043: fetched fixtures must pass without a STEP header exemption.
test('a fetched fixture with scrubbed STEP author and organisation passes the privacy scan', () =>
  withFetchedFixture("('')", "('')", root => {
    const { errors, notes } = run(root);
    assert.deepEqual(errors, []);
    assert.ok(!notes.some(note => /fzk-haus: not fetched/.test(note)), 'the fixture was scanned, not skipped');
  }));

test('a fetched fixture is refused if either STEP author or organisation is restored', async () => {
  for (const [author, organisation] of [["('Architect')", "('')"], ["('')", "('Building Designer Office')"]]) {
    await withFetchedFixture(author, organisation,
      root => assert.ok(run(root).errors.some(error => /fixture fzk-haus: privacy scan: STEP author\/organisation present/.test(error))));
  }
});
