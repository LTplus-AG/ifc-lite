// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const launcherUrl = new URL('./run-csg-work-bundle.mjs', import.meta.url);
const consumer = spawnSync(process.execPath, ['--input-type=module', '--eval', `
  import assert from 'node:assert/strict';
  import { createHash } from 'node:crypto';
  const { runChild } = await import(${JSON.stringify(launcherUrl.href)});
  const result = await runChild(['-e', "process.stdout.write('owned-consumer-output')"]);
  assert.equal(result.observedClose, true);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.toString(), 'owned-consumer-output');
  assert.equal(result.stdoutSha256, createHash('sha256').update('owned-consumer-output').digest('hex'));
`], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
function launcherTest(name, options, body) {
  if (typeof options === 'function') { body = options; options = {}; }
  test(name, options, async () => {
    // #6516: keep every original control registered if production is removed;
    // missing imports fail this actual owned-child output/close invariant.
    assert.equal(consumer.status, 0, 'the real Node consumer could not capture and close its owned child');
    assert.equal(consumer.signal, null);
    return body();
  });
}
// No substitute implementation or skipped controls on a missing production file.
const { verifyBundle, runChild, validateReport, persistAttempt } = existsSync(launcherUrl)
  ? await import(launcherUrl.href) : {};

const digest = value => createHash('sha256').update(value).digest('hex');
const pins = { geometryEntrySha256: 'a'.repeat(64), wasmGlueSha256: 'b'.repeat(64), wasmSha256: 'c'.repeat(64) };
const input = { bytes: 100, sha256: 'd'.repeat(64) };
function ordinary() {
  return { schemaVersion: 'csg-work-positive-observation-v1', diagnosticOnly: true,
    mode: 'ordinary', reason: null, status: 'ORDINARY_OUTPUT_OBSERVATION', node: process.version,
    canonicalCompleteEvents: 1, fileBytes: input.bytes, sourceContentSha256: input.sha256, ...pins,
    sourceContentBinding: 'ORIGINAL_FILE_BYTES_PASSED_TO_CANONICAL_SDK_ARGS0_NOT_INDEPENDENTLY_HASHED',
    meshDigestProtocol: 'raw-mesh-24-v1', convertedMeshProtocol: 'stock-converted-mesh-6-v1',
    meshes: 1, triangles: 2, convertedMeshes: 1, convertedTriangles: 2, convertedBatches: 1,
    raw24MeshMultisetSha256: 'e'.repeat(64), convertedMeshMultisetSha256: 'f'.repeat(64),
    limits: { completeness: 'UNVERIFIED', operandCountTruncation: 'UNVERIFIED', lockHealth: 'UNVERIFIED',
      emptyArrayMeaning: 'NOT_PROOF_OF_ZERO_WORK' },
    libraryLogLines: { log: 0, info: 1, warn: 2, error: 0, debug: 0 },
    executionAccounting: { canonicalSdkStreamCalls: 1, failedOrUnreportedReplayAttempts: 0,
      ordinaryReferenceBatchesCompleted: 1, extraIndividualWasmBatchReplaysCompleted: 0 },
    jobs: [], canonicalBatchIdentity: 'UNAVAILABLE_NO_REPLAYS', observedPopulation: 'UNAVAILABLE_NO_REPLAYS' };
}
function diagnostic() {
  const report = ordinary();
  const triple = [344, 10, 80];
  report.mode = 'diagnostic'; report.status = 'POSITIVE_OBSERVATION'; report.canonicalBatchIdentity = true;
  report.executionAccounting.extraIndividualWasmBatchReplaysCompleted = 1;
  report.observedPopulation = { observedJobs: 1, retainedJobs: 1, observedRowsRetainedWithoutClipping: true,
    readerPopulationStatus: 'ALL_OBSERVED_ROWS_RETAINED', refusal: null };
  report.jobs = [{ sourceJobTriple: triple, sourceJobKeyProtocol: 'source-job-triple-v1',
    sourceJobKey: digest(JSON.stringify(['source-job-triple-v1', input.sha256, ...triple])),
    ordinal: 0, duplicateOccurrence: 0, outputDigestProtocol: 'raw-mesh-24-v1',
    raw24MeshMultisetSha256: report.raw24MeshMultisetSha256, meshes: 1, triangles: 2,
    observedWrapperEntries: [[0, 80, 872]] }];
  return report;
}

launcherTest('#6516 changed same-release output refuses while warning counts are retained', () => {
  const baseline = ordinary(), report = ordinary();
  assert.doesNotThrow(() => validateReport(report, { mode: 'ordinary', input, pins, baseline }));
  report.raw24MeshMultisetSha256 = '0'.repeat(64);
  assert.throws(() => validateReport(report, { mode: 'ordinary', input, pins, baseline }), /SAME_RELEASE_OUTPUT/);
  const changedLogs = ordinary(); changedLogs.libraryLogLines.warn++;
  assert.throws(() => validateReport(changedLogs, { mode: 'ordinary', input, pins, baseline }), /ORDINARY_LOGS/);
});

launcherTest('#6516 incomplete stream/runtime mismatch and wrong public output refuse', () => {
  const missing = ordinary(); missing.canonicalCompleteEvents = 0;
  assert.throws(() => validateReport(missing, { mode: 'ordinary', input, pins }), /INPUT_COMPLETE/);
  const stale = ordinary(); stale.wasmSha256 = '0'.repeat(64);
  assert.throws(() => validateReport(stale, { mode: 'ordinary', input, pins }), /RUNTIME_PIN/);
  assert.throws(() => validateReport(ordinary(), { mode: 'ordinary', input, pins, publicRelease: 6 }), /PUBLIC_GROUND_TRUTH/);
});

launcherTest('#6516 replay identity/span/duplicates/tuple schema and complete-census overclaim refuse', () => {
  const options = { mode: 'diagnostic', input, pins, baseline: ordinary() };
  assert.doesNotThrow(() => validateReport(diagnostic(), options));
  for (const [mutate, reason] of [
    [r => { r.canonicalBatchIdentity = false; }, /REPLAY_IDENTITY/],
    [r => { r.jobs[0].sourceJobTriple[2] = 101; }, /JOB_SPAN/],
    [r => { r.jobs[0].duplicateOccurrence = 1; }, /JOB_KEY/],
    [r => { r.jobs[0].observedWrapperEntries[0][0] = 4; }, /JOB_OUTPUT/],
    [r => { r.limits.completeness = 'VERIFIED'; }, /POSITIVE_ONLY/],
  ]) {
    const r = diagnostic(); mutate(r);
    assert.throws(() => validateReport(r, options), reason);
  }
  const emptyEntries = diagnostic(); emptyEntries.jobs[0].observedWrapperEntries = [];
  assert.doesNotThrow(() => validateReport(emptyEntries, options)); // Empty is retained, never certified as zero work.
});

launcherTest('#6516 owned real Node timeout closes and retains pre-timeout stdout', async () => {
  await assert.rejects(runChild(['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
    { timeoutMs: 2000 }), error => {
    assert.match(error.message, /CHILD_TIMEOUT/);
    assert.equal(error.observation.observedClose, true);
    assert.equal(error.observation.stdout.toString(), 'ready');
    assert.notEqual(error.observation.code, 0);
    return true;
  });
});

launcherTest('#6516 owned real Node output cap terminates instead of truncating to success', async () => {
  await assert.rejects(runChild(['-e', "process.stdout.write('x'.repeat(65536)); setInterval(() => {}, 1000)"],
    { timeoutMs: 5000, maxBytes: 1024 }), error => {
    assert.match(error.message, /CHILD_OUTPUT_CAP/);
    assert.equal(error.observation.observedClose, true);
    assert.ok(error.observation.stdout.length <= 1024);
    assert.notEqual(error.observation.code, 0);
    return true;
  });
});

launcherTest('#6516 bundle verifies actual bytes and rejects omitted/modified inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'csg-work-bundle-'));
  try {
    const files = [], projects = {};
    const put = async (path, text) => {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), text);
      files.push({ path, bytes: Buffer.byteLength(text), sha256: digest(text) });
    };
    await put('csg-work-diagnostic.mjs', '// finite file fixture\n');
    await put('run-csg-work-bundle.mjs', '// finite file fixture\n');
    for (const role of ['release6-stock', 'release6-on', 'release7-stock', 'release7-on']) {
      projects[role] = { geometryEntry: 'geometry.js', wasmGlue: 'wasm.js', wasmBinary: 'wasm.bin' };
      for (const path of Object.values(projects[role])) await put(`projects/${role}/${path}`, 'fixture-' + path);
    }
    const manifest = { schemaVersion: 'csg-work-bundle-v1', nodeMajor: 24, files, projects };
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    assert.equal((await verifyBundle(root)).indexed.size, files.length);
    await writeFile(join(root, 'extra.txt'), 'unlisted');
    await assert.rejects(verifyBundle(root), /BUNDLE_FILE_HASH/);
    await rm(join(root, 'extra.txt'));
    await writeFile(join(root, 'csg-work-diagnostic.mjs'), '// changed bytes\n');
    await assert.rejects(verifyBundle(root), /BUNDLE_FILE_HASH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


launcherTest('#6516 actual parent SIGTERM terminates its own child and records observed close',
  { skip: process.platform === 'win32' ? 'Windows kill(SIGTERM) forcibly terminates the parent; console SIGINT delivery needs native qualification' : false },
  async () => {
    const moduleUrl = new URL('./run-csg-work-bundle.mjs', import.meta.url).href;
    const code = `import { runChild } from ${JSON.stringify(moduleUrl)};
      process.stdout.write('parent-ready\\n');
      try { await runChild(['-e', "process.stdout.write('child-ready'); setInterval(() => {}, 1000)"], {timeoutMs:10000}); }
      catch(error) { process.stdout.write(JSON.stringify({refusal:error.observation.refusal,
        observedClose:error.observation.observedClose, stdout:error.observation.stdout.toString()})+'\\n'); }`;
    const parent = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    parent.stdout.on('data', bytes => { output += bytes; });
    parent.stderr.on('data', bytes => { errors += bytes; });
    const deadline = setTimeout(() => parent.kill('SIGKILL'), 12000);
    try {
      // Signal after the launcher has started the owned child, not during imports.
      await new Promise((resolveReady, reject) => {
        const timer = setTimeout(() => reject(new Error('Parent readiness timeout')), 3000);
        parent.stdout.once('data', () => { clearTimeout(timer); setTimeout(resolveReady, 500); });
      });
      parent.kill('SIGTERM');
      const exit = await new Promise(resolveExit => parent.once('close', (status, signal) => resolveExit({status, signal})));
      assert.deepEqual(exit, {status:0, signal:null}, errors);
      const receipt = JSON.parse(output.trim().split('\n').at(-1));
      assert.equal(receipt.refusal, 'CHILD_INTERRUPTED');
      assert.equal(receipt.observedClose, true);
      assert.equal(receipt.stdout, 'child-ready');
    } finally { clearTimeout(deadline); if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL'); }
  });

launcherTest('#6516 invalid/refused child output persists hashes only, never raw private text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'csg-work-log-'));
  try {
    const secret = 'PRIVATE_INPUT_PATH_OR_ERROR';
    for (const [name, text] of [['invalid', secret], ['refused', JSON.stringify({status:'REFUSED',reason:secret})]]) {
      const observed = await runChild(['-e', `process.stdout.write(${JSON.stringify(text)}); process.stderr.write('private stderr');`]);
      await persistAttempt(root, name, observed);
      const receipt = JSON.parse(await readFile(join(root, name + '.attempt.json'), 'utf8'));
      assert.equal(receipt.stdoutBytes, Buffer.byteLength(text));
      assert.equal(receipt.stdoutSha256, digest(text));
      assert.equal(receipt.stderrSha256, digest('private stderr'));
      assert.equal(receipt.observedClose, true);
      assert.deepEqual(receipt, {
        schemaVersion: 'csg-work-child-attempt-v1', stdoutBytes: Buffer.byteLength(text),
        stderrBytes: Buffer.byteLength('private stderr'), stdoutSha256: digest(text),
        stderrSha256: digest('private stderr'), exitCode: 0, signal: null,
        observedClose: true, refusal: null, closeDeadlineRefusal: null,
        structuredReportStatus: 'UNVALIDATED_RAW_WITHHELD',
        rawLogs: 'WITHHELD_NO_STDOUT_OR_STDERR_TEXT_STORED',
      });
      if (name === 'invalid') assert.throws(() => JSON.parse(observed.stdout.toString()));
      else await assert.rejects(persistAttempt(root, name, observed, JSON.parse(text)), /REPORT_PERSISTENCE/);
    }
    assert.deepEqual((await readdir(root)).sort(), ['invalid.attempt.json','refused.attempt.json']);
  } finally { await rm(root, {recursive:true, force:true}); }
});
