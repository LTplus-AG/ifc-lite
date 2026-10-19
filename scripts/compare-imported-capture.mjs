// SPDX-License-Identifier: MPL-2.0
// Fixture-only comparison against an explicitly supplied immutable consumer capture.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const [baselineArgument, destinationArgument] = process.argv.slice(2);
if (!baselineArgument || !destinationArgument) throw Error('Usage: node scripts/compare-imported-capture.mjs BASE_CAPTURE NEW_OUTPUT');
const root = resolve(import.meta.dirname, '..');
const baseline = resolve(baselineArgument);
const destination = resolve(destinationArgument);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const qualification = json(resolve(baseline, 'evidence/qualification.json'));
assert.match(qualification.sourceCommit, /^[0-9a-f]{40}$/u);
// Preserve baseline evidence and require its recorded integrity before executing
// the captured direct-case harness or reading its output as an oracle.
execFileSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: baseline, stdio: 'pipe' });
const metadata = json(resolve(baseline, 'summary.json')).metadata;
for (const fixture of metadata) {
  assert.equal(digest(readFileSync(resolve(root, 'tests/models', fixture.name))), fixture.sha256, fixture.name);
}
const importer = resolve(root, 'tools/smlib-evaluation/scene-comparison/ifcx/importer.mjs');
assert.equal(digest(readFileSync(importer)), digest(readFileSync(resolve(baseline, 'evidence/historical-harness-importer.mjs'))), 'Use the same consumer capture harness');
mkdirSync(destination); // A new destination is required; never replace evidence.
execFileSync(process.execPath, ['--import', 'tsx', importer, resolve(root, 'packages/ifcx/src/index.ts'), root, resolve(destination, 'scenes')], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, ['--import', 'tsx', resolve(baseline, 'evidence/direct-extractor.mjs'), root, resolve(destination, 'direct-extractor-results.json')], { cwd: root, stdio: 'inherit' });
const records = [];
for (const name of readdirSync(baseline).filter(name => name.endsWith('.json') && name !== 'summary.json').sort()) {
  const original = readFileSync(resolve(baseline, name));
  const current = readFileSync(resolve(destination, 'scenes', name));
  assert.equal(digest(original), qualification.outputFiles[name].sha256, `Captured identity: ${name}`);
  assert.deepEqual(JSON.parse(current), JSON.parse(original), name);
  records.push({ name, baselineSha256: digest(original), candidateSha256: digest(current), exactFieldsEqual: true });
}
assert.equal(records.length, qualification.consumerSceneCount);
const directBase = readFileSync(resolve(baseline, 'evidence/direct-extractor-results.json'));
const directCurrent = readFileSync(resolve(destination, 'direct-extractor-results.json'));
assert.deepEqual(JSON.parse(directCurrent), JSON.parse(directBase), 'Direct raw-bit cases');
assert.equal(JSON.parse(directCurrent).cases.length, qualification.directCases);
const provenance = json(resolve(root, 'packages/ifcx/src/generated/imported-geometry.provenance.json'));
const receipt = {
  baselineSource: qualification.sourceCommit,
  baselineQualificationSha256: digest(readFileSync(resolve(baseline, 'evidence/qualification.json'))),
  candidateSource: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  candidateEntry: 'packages/ifcx/src/index.ts',
  candidateStaticSha256: provenance.staticSha256,
  candidateStaticVerified: digest(readFileSync(resolve(root, 'packages/ifcx/src/generated/imported-geometry-static.js'))) === provenance.staticSha256,
  mode: 'fixture-only production-source consumer execution; no build',
  records, directCases: qualification.directCases,
  directBaselineSha256: digest(directBase), directCandidateSha256: digest(directCurrent),
  scope: 'Captured full scene fields, ordering, typed-array bytes, float bits, errors and absence; full/incremental overlays asserted by original harness',
  exclusions: ['parseTime', 'ephemeral layer UUIDs replaced by supplied filenames'],
  limits: ['No viewer/GPU/module Worker execution', 'No new USD export/reopen or performance run',
    'Historical harness summary saying no Rust numerical call describes its old capture; current target executes generated Rust static JS',
    'Independent pre-migration comparison; does not replace immediate-parent artifact/source comparison'],
};
assert(receipt.candidateStaticVerified);
writeFileSync(resolve(destination, 'comparison.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(`Pre-migration production consumer: ${records.length} scenes and ${qualification.directCases} direct cases exactly equal`);
