/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Standalone, untimed #8042 preparation. Parent supplies ONE outer admission.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, stat, rm, link } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const [rootArg, sourceArg, outputArg] = process.argv.slice(2);
assert.ok(rootArg && sourceArg && outputArg && process.argv.length === 5,
  'Usage: node prepare-diff-large-revision.mjs BUILT_ROOT SOURCE_IFC NEW_OUTPUT_DIRECTORY');
const root = resolve(rootArg), source = resolve(sourceArg), out = resolve(outputArg);
const harness = resolve(fileURLToPath(new URL('../..', import.meta.url)));
for (const checkout of [root, harness]) {
  const rel = relative(checkout, out);
  assert.ok(rel.startsWith('..') || isAbsolute(rel), 'output must be outside code checkouts');
}
assert.ok(source !== out && !source.startsWith(out + '/'), 'output cannot contain source');
await mkdir(out); // exclusive directory claim; existing destinations always refuse
const scratch = await mkdtemp(join(out, '.owned-'));
const json = path => readFile(path, 'utf8').then(JSON.parse);
const save = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
const receipt = { version: 'ifc-large-preparation/2', status: 'preparing',
  performanceVerdict: 'not-assessed', fullIssue8042Accepted: false,
  commands: [], root, harness, source, startedAt: new Date().toISOString(),
  limits: { fixtureBytes: 512 * 1024 * 1024, childOldSpaceMiB: 12288,
    childTimeoutMs: 1800000, childLogBytes: 256 * 1024 },
  timestampPolicy: 'No byte-deterministic derivation claim. CLI uses wall-time headers. Require identical complete indexed record bytes, nonrecord bytes outside the canonical header, fingerprints and oracle results across repeats; only parsed timeStamp may differ. Freeze first generated file exact SHA256 for BOTH A/B arms; never regenerate/substitute during timing.' };
const git = cwd => ({ commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(),
  status: execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim() });
async function file(path, bound = false) {
  const info = await stat(path);
  if (bound) assert.ok(info.size > 0 && info.size <= receipt.limits.fixtureBytes, 'IFC file bound');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { path, bytes: info.size, sha256: hash.digest('hex') };
}
async function child(label, args, env = {}) {
  const identity = { label, executable: process.execPath, args: ['--max-old-space-size=12288', ...args], cwd: root,
    env, successful: false, startedAt: new Date().toISOString() };
  receipt.commands.push(identity);
  let stdout = '', stderr = '', bytes = 0;
  const proc = spawn(process.execPath, ['--max-old-space-size=12288', ...args], {
    cwd: root, detached: true, env: { ...process.env, NODE_OPTIONS: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let violation;
  const stop = reason => { violation ??= reason; try { process.kill(-proc.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; } };
  const timer = setTimeout(() => stop('child timeout'), receipt.limits.childTimeoutMs);
  const abort = () => stop('parent interrupted');
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const collect = stream => chunk => {
    bytes += chunk.length;
    if (bytes > receipt.limits.childLogBytes) { stop('child log bound'); return; }
    if (stream === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
  };
  proc.stdout.on('data', collect('stdout')); proc.stderr.on('data', collect('stderr'));
  try {
    const code = await new Promise((res, rej) => { proc.once('error', rej); proc.once('close', res); });
    identity.exitCode = code; identity.violation = violation;
    assert.ok(code === 0 && !violation, `${label} failed (${code}): ${violation ?? stderr}`);
    identity.successful = true;
    return stdout;
  } finally {
    clearTimeout(timer); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    identity.finishedAt = new Date().toISOString();
    await writeFile(join(out, `${label}.log`), JSON.stringify({ identity, stdout, stderr }, null, 2), { flag: 'wx' });
  }
}
const helper = fileURLToPath(new URL('./diff-large-revision-child.mjs', import.meta.url));
const cli = join(root, 'packages/cli/dist/index.js');
const recipePath = join(out, 'recipe.json');
const baseRows = join(scratch, 'base.json'), headRows = join(scratch, 'head.json');
const final = join(out, 'controlled-revision.ifc');
async function mutate(label, input, output, recipe) {
  const selector = ['--type', recipe.queryType], assignment = `Name=${recipe.newName}`;
  const result = JSON.parse(await child(label, [cli, 'mutate', input, ...selector,
    '--set', assignment, '--out', output, '--json']));
  assert.equal(result.mutated, recipe.targets.length); assert.deepEqual(result.skipped, []);
  assert.ok(!result.warnings || result.warnings.length === 0);
  await file(output, true);
  return result;
}
try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.ok((major === 22 && minor >= 13) || major === 24, 'use Node 22.13+ (22.x) or 24.x');
  receipt.sourceIdentity = git(root); receipt.harnessIdentity = git(harness);
  assert.equal(receipt.sourceIdentity.status, '', 'built root must be clean');
  assert.equal(receipt.harnessIdentity.status, '', 'commit preparation code before execution');
  receipt.runtime = await file(process.execPath);
  receipt.runtime.node = process.version;
  receipt.scriptFiles = await Promise.all([file(fileURLToPath(import.meta.url)), file(helper),
    file(join(harness, 'scripts/perf/diff-e2e-protocol.mjs')),
    file(join(root, 'scripts/lib/diff-oracle.mjs')), file(cli)]);
  receipt.sourceFile = await file(source, true);
  assert.equal(receipt.sourceFile.bytes, 342657851, 'expected Bouwkundig fixture');
  assert.equal(receipt.sourceFile.sha256, 'e91ddbbd672bbde946af14631de4c732f0cf8a7cfae5dbbf06fbeab03b5c46df');
  await child('select', [helper, 'select', root, source, baseRows, recipePath],
    { IFC_SOURCE_SHA256: receipt.sourceFile.sha256 });
  const recipe = await json(recipePath);
  receipt.recipe = await file(recipePath);
  const derive = async suffix => {
    const output = join(scratch, `revision-${suffix}.ifc`);
    await mutate(`name-${suffix}`, source, output, recipe);
    return output;
  };
  const first = await derive('first');
  await child('inspect', [helper, 'inspect', root, first, headRows, recipePath]);
  await child('oracle', [helper, 'oracle', root, baseRows, headRows, recipePath]);
  const base = await json(`${baseRows}.summary.json`), head = await json(`${headRows}.summary.json`);
  assert.deepEqual(head.counts, base.counts, 'full entity/subtype counts changed');
  for (const key of ['author', 'organization', 'authorization', 'originatingSystem',
    'implementationLevel', 'schemaIdentifiers']) {
    assert.deepEqual(head.sourceHeader[key], base.sourceHeader[key], `source attribution lost: ${key}`);
  }
  assert.deepEqual(head.sourceHeader.description.slice(0, base.sourceHeader.description.length),
    base.sourceHeader.description, 'source description overwritten');
  receipt.base = base; receipt.head = head;
  const second = await derive('repeat');
  const repeatRows = join(scratch, 'repeat.json');
  await child('inspect-repeat', [helper, 'inspect', root, second, repeatRows, recipePath]);
  await child('oracle-repeat', [helper, 'oracle', root, baseRows, repeatRows, recipePath]);
  assert.equal((await file(headRows)).sha256, (await file(repeatRows)).sha256,
    'repeated semantic output differs');
  receipt.repeat = await json(`${repeatRows}.summary.json`);
  receipt.firstFile = await file(first, true); receipt.repeatFile = await file(second, true);
  assert.deepEqual(receipt.repeat.counts, head.counts, 'repeat full counts differ');
  assert.equal(receipt.repeat.canonicalFingerprintsSha256, head.canonicalFingerprintsSha256,
    'repeated canonical fingerprint structure differs (including optional fields)');
  assert.equal(receipt.repeat.indexedRecordBytes, head.indexedRecordBytes);
  assert.equal(receipt.repeat.indexedRecordsSha256, head.indexedRecordsSha256,
    'repeated full canonical indexed entity-record bytes differ');
  assert.equal(receipt.repeat.nonrecordBytesSha256, head.nonrecordBytesSha256,
    'unaccounted differences outside indexed records/canonical header');
  receipt.headerDifferences = Object.fromEntries(
    [...new Set([...Object.keys(head.sourceHeader), ...Object.keys(receipt.repeat.sourceHeader)])]
      .filter(key => JSON.stringify(head.sourceHeader[key]) !== JSON.stringify(receipt.repeat.sourceHeader[key]))
      .map(key => [key, { first: head.sourceHeader[key], repeat: receipt.repeat.sourceHeader[key] }]));
  assert.ok(Object.keys(receipt.headerDifferences).every(key => key === 'timeStamp'),
    'unaccounted repeated header differences');
  assert.equal((await file(`${headRows}.expected.json`)).sha256,
    (await file(`${repeatRows}.expected.json`)).sha256, 'repeated oracle results differ');
  receipt.repeatedFileBytesEqual = receipt.firstFile.sha256 === receipt.repeatFile.sha256;
  receipt.byteDeterministicDerivationClaimed = false;
  if (!receipt.repeatedFileBytesEqual) assert.ok(receipt.headerDifferences.timeStamp,
    'unequal file hashes without an accounted timestamp difference');
  receipt.expected = await json(`${headRows}.expected.json`);
  const expectationsPath = join(out, 'expected.json');
  await save(expectationsPath, receipt.expected);
  receipt.expectationsFile = await file(expectationsPath);
  assert.deepEqual(await file(source, true), receipt.sourceFile, 'source changed during preparation');
  assert.deepEqual(git(root), receipt.sourceIdentity); assert.deepEqual(git(harness), receipt.harnessIdentity);
  await link(first, final); // atomic no-replace publication within the owned filesystem
  receipt.outputFile = await file(final, true);
  assert.equal(receipt.outputFile.sha256, receipt.firstFile.sha256, 'published bytes changed');
  receipt.frozenHeadForBothArms = receipt.outputFile;
  receipt.freezePolicy = 'Parent must bind this ONE exact head file plus source, recipe and expectations in reviewed protocol bindings before timing. Verifier/cohort must reconcile exact frozen file bytes and identities throughout; timestamp tolerance applies only to this preparation repeat comparison.';
  receipt.status = 'prepared-unmeasured';
  await save(join(out, 'evidence.json'), receipt);
  await rm(scratch, { recursive: true });
} catch (error) {
  receipt.status = 'failed-unmeasured'; receipt.error = error.stack ?? String(error);
  receipt.retainedScratch = scratch;
  await save(join(out, 'evidence.json'), receipt);
  process.stderr.write(`${receipt.error}\nEvidence retained at ${out}\n`);
  process.exitCode = 1;
}
