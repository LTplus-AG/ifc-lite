// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// #6516 private-file diagnostic delivery. No timing or complete-census verdict.
import { createHash } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { lstat, readFile, readdir, realpath, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve, relative, isAbsolute, sep, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file is copied on its own into the work bundle (see `copyProjectTools` in
// build-csg-work-bundle.mjs), where scripts/lib does not exist, so the entry-point
// check is spelled here instead of imported. Same rule as scripts/lib/is-main-entry.mjs:
// `argv[1]` is resolved through realpath, because `import.meta.url` already is.
function isMainEntry(moduleUrl) {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

const ROLES = ['release6-stock', 'release6-on', 'release7-stock', 'release7-on'];
const SHA = /^[a-f0-9]{64}$/;
const PUBLIC_SHA = '1d1cd11c57d80fe4f769a05db49cf1a96973b1af6cbee2d75ef541cfa3cb8fa0';
const PUBLIC_OUTPUT = {
  6: [5833, '981d74ad4aa4ee39ef08e56f1ed321fe06572270269050d586edddb5debfde16'],
  7: [6732, '37bdaf83404efaa9ec90f2c8f9e60e882ac18b290ed33bc1b1609aa9cd994e38'],
};
const MAX_OUTPUT = 16 * 1024 * 1024;
const fail = category => { throw new Error(`REFUSE ${category}`); };
const need = (condition, category) => { if (!condition) fail(category); };
const uint = (n, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const hash = value => createHash('sha256').update(value).digest('hex');
async function fileHash(path) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest('hex');
}
function safePath(path) {
  return typeof path === 'string' && path.length <= 4096 && !path.includes('\\')
    && !path.includes(':') && !isAbsolute(path) && path.split('/').length <= 20
    && path.split('/').every(x => x && x !== '.' && x !== '..');
}

/** Verify every delivered file, not merely the three runtime entry files. */
export async function verifyBundle(root) {
  const manifestPath = join(root, 'manifest.json');
  const info = await lstat(manifestPath);
  need(info.isFile() && !info.isSymbolicLink() && info.size <= MAX_OUTPUT, 'MANIFEST_FILE');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  need(manifest.schemaVersion === 'csg-work-bundle-v1' && manifest.nodeMajor === 24
    && Array.isArray(manifest.files) && manifest.files.length <= 16_384
    && Object.keys(manifest.projects).sort().join('|') === [...ROLES].sort().join('|'), 'MANIFEST_SCHEMA');
  const indexed = new Map();
  let total = 0;
  for (const row of manifest.files) {
    need(safePath(row.path) && row.path !== 'manifest.json' && !indexed.has(row.path)
      && uint(row.bytes) && row.bytes <= 64 * 1024 * 1024 && SHA.test(row.sha256), 'MANIFEST_ENTRY');
    total += row.bytes;
    need(total <= 512 * 1024 * 1024, 'BUNDLE_BYTE_CAP');
    indexed.set(row.path, row);
  }
  const seen = new Set();
  let entriesVisited = 0;
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      need(++entriesVisited <= 32_768, 'BUNDLE_ENTRY_CAP');
      const name = prefix + entry.name;
      need(safePath(name) && !entry.isSymbolicLink(), 'BUNDLE_PATH');
      if (entry.isDirectory()) await visit(join(directory, entry.name), name + '/');
      else {
        need(entry.isFile(), 'BUNDLE_FILE_TYPE');
        if (name === 'manifest.json') continue;
        const row = indexed.get(name), path = join(root, ...name.split('/'));
        const stat = await lstat(path);
        need(row && stat.isFile() && stat.size === row.bytes && await fileHash(path) === row.sha256,
          'BUNDLE_FILE_HASH');
        seen.add(name);
      }
    }
  }
  await visit(root);
  need(seen.size === indexed.size && indexed.has('csg-work-diagnostic.mjs')
    && indexed.has('run-csg-work-bundle.mjs'), 'BUNDLE_COMPLETE_CENSUS');
  for (const role of ROLES) for (const key of ['geometryEntry', 'wasmGlue', 'wasmBinary']) {
    const path = manifest.projects[role][key];
    need(safePath(path) && indexed.has(`projects/${role}/${path}`), 'PROJECT_RUNTIME_PIN');
  }
  return { manifest, indexed, manifestSha256: await fileHash(manifestPath) };
}

/** Fresh owned Node only; no subprocess group or whole-machine ownership claim. */
export function runChild(argv, { cwd, timeoutMs = 180_000, maxBytes = MAX_OUTPUT } = {}) {
  return new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, argv, { cwd, shell: false, windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], hashes = [createHash('sha256'), createHash('sha256')], counts = [0, 0];
    let reason, killTimer, closeTimer, settled = false;
    const interrupt = () => stop('CHILD_INTERRUPTED');
    const signals = ['SIGINT', 'SIGTERM'];
    function finish(code, signal, observedClose) {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(closeTimer);
      for (const name of signals) process.removeListener(name, interrupt);
      const result = { stdout: Buffer.concat(stdout), stdoutBytes: counts[0], stderrBytes: counts[1],
        stdoutSha256: hashes[0].digest('hex'), stderrSha256: hashes[1].digest('hex'),
        code, signal, observedClose, closeDeadlineRefusal: observedClose ? null : 'CHILD_CLOSE_UNOBSERVED',
        refusal: reason ?? (code !== 0 || signal ? 'CHILD_EXIT' : null) };
      if (result.refusal) {
        const error = new Error(`REFUSE ${result.refusal}`);
        error.observation = result;
        reject(error);
      } else resolveChild(result);
    }
    function stop(category) {
      if (reason) return;
      reason = category;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        closeTimer = setTimeout(() => {
          child.stdout.destroy(); child.stderr.destroy(); child.unref();
          finish(null, null, false); // No observed close: never certify cleanup.
        }, 5000);
      }, 2000);
    }
    function collect(index, chunk) {
      counts[index] += chunk.length; hashes[index].update(chunk);
      if (counts[0] + counts[1] > maxBytes) stop('CHILD_OUTPUT_CAP');
      else if (index === 0) stdout.push(chunk);
    }
    child.stdout.on('data', chunk => collect(0, chunk));
    child.stderr.on('data', chunk => collect(1, chunk));
    child.on('error', () => stop('CHILD_SPAWN'));
    for (const name of signals) process.on(name, interrupt);
    const timer = setTimeout(() => stop('CHILD_TIMEOUT'), timeoutMs);
    child.on('close', (code, signal) => finish(code, signal, true));
  });
}

/** Keep only raw-byte hashes/counts and successfully validated structured reports. */
export async function persistAttempt(directory, name, observation, report) {
  if (report) need(observation.observedClose && observation.code === 0 && !observation.refusal
    && ['POSITIVE_OBSERVATION', 'ORDINARY_OUTPUT_OBSERVATION'].includes(report.status), 'REPORT_PERSISTENCE');
  const receipt = { schemaVersion: 'csg-work-child-attempt-v1', stdoutBytes: observation.stdoutBytes,
    stderrBytes: observation.stderrBytes, stdoutSha256: observation.stdoutSha256,
    stderrSha256: observation.stderrSha256, exitCode: observation.code, signal: observation.signal,
    observedClose: observation.observedClose, refusal: observation.refusal,
    closeDeadlineRefusal: observation.closeDeadlineRefusal,
    structuredReportStatus: report ? 'VALIDATED' : 'UNVALIDATED_RAW_WITHHELD',
    rawLogs: 'WITHHELD_NO_STDOUT_OR_STDERR_TEXT_STORED' };
  await writeFile(join(directory, name + '.attempt.json'), JSON.stringify(receipt, null, 2) + '\n');
  if (report) await writeFile(join(directory, name + '.json'), JSON.stringify(report, null, 2) + '\n');
}

/** Same finite predicates as the six public controls, now binding a private input. */
export function validateReport(r, { mode, input, pins, baseline, publicRelease }) {
  const diagnostic = mode === 'diagnostic';
  need(r.schemaVersion === 'csg-work-positive-observation-v1' && r.diagnosticOnly === true
    && r.mode === mode && r.reason === null
    && r.status === (diagnostic ? 'POSITIVE_OBSERVATION' : 'ORDINARY_OUTPUT_OBSERVATION'), 'REPORT_STATUS');
  need(r.node === process.version && r.canonicalCompleteEvents === 1
    && r.fileBytes === input.bytes && r.sourceContentSha256 === input.sha256, 'INPUT_COMPLETE');
  for (const key of ['geometryEntrySha256', 'wasmGlueSha256', 'wasmSha256']) need(r[key] === pins[key], 'RUNTIME_PIN');
  need(r.sourceContentBinding === 'ORIGINAL_FILE_BYTES_PASSED_TO_CANONICAL_SDK_ARGS0_NOT_INDEPENDENTLY_HASHED'
    && r.meshDigestProtocol === 'raw-mesh-24-v1' && r.convertedMeshProtocol === 'stock-converted-mesh-6-v1', 'PROTOCOL');
  need(uint(r.meshes) && r.meshes > 0 && uint(r.triangles) && r.convertedMeshes === r.meshes
    && r.convertedTriangles === r.triangles && uint(r.convertedBatches) && r.convertedBatches > 0
    && SHA.test(r.raw24MeshMultisetSha256) && SHA.test(r.convertedMeshMultisetSha256), 'OUTPUT');
  need(['completeness', 'operandCountTruncation', 'lockHealth'].every(k => r.limits?.[k] === 'UNVERIFIED')
    && r.limits.emptyArrayMeaning === 'NOT_PROOF_OF_ZERO_WORK', 'POSITIVE_ONLY');
  const logs = r.libraryLogLines;
  need(logs && Object.keys(logs).sort().join('|') === 'debug|error|info|log|warn'
    && Object.values(logs).every(x => uint(x)), 'LOG_COUNTS');
  const a = r.executionAccounting;
  need(a?.canonicalSdkStreamCalls === 1 && a.failedOrUnreportedReplayAttempts === 0
    && uint(a.ordinaryReferenceBatchesCompleted) && a.ordinaryReferenceBatchesCompleted > 0
    && Array.isArray(r.jobs) && r.jobs.length <= 4096, 'EXECUTION_ACCOUNTING');
  if (!diagnostic) need(r.jobs.length === 0 && a.extraIndividualWasmBatchReplaysCompleted === 0
    && r.canonicalBatchIdentity === 'UNAVAILABLE_NO_REPLAYS'
    && r.observedPopulation === 'UNAVAILABLE_NO_REPLAYS', 'ORDINARY_REPLAYS');
  else {
    const p = r.observedPopulation;
    need(r.canonicalBatchIdentity === true && r.jobs.length > 0 && p?.observedJobs === r.jobs.length
      && p.retainedJobs === r.jobs.length && p.observedRowsRetainedWithoutClipping === true
      && p.readerPopulationStatus === 'ALL_OBSERVED_ROWS_RETAINED' && p.refusal === null
      && a.extraIndividualWasmBatchReplaysCompleted === r.jobs.length, 'REPLAY_IDENTITY');
    const occurrences = new Map();
    for (const [ordinal, row] of r.jobs.entries()) {
      const t = row.sourceJobTriple;
      need(Array.isArray(t) && t.length === 3 && t.every(x => uint(x, 0xffff_ffff))
        && t[0] > 0 && t[1] < t[2] && t[2] <= input.bytes, 'JOB_SPAN');
      const key = hash(JSON.stringify(['source-job-triple-v1', input.sha256, ...t]));
      need(row.sourceJobKeyProtocol === 'source-job-triple-v1' && row.sourceJobKey === key
        && row.ordinal === ordinal && row.duplicateOccurrence === (occurrences.get(key) ?? 0), 'JOB_KEY');
      occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
      need(row.outputDigestProtocol === 'raw-mesh-24-v1' && SHA.test(row.raw24MeshMultisetSha256)
        && uint(row.meshes) && uint(row.triangles) && Array.isArray(row.observedWrapperEntries)
        && row.observedWrapperEntries.length <= 16_384
        && row.observedWrapperEntries.every(x => Array.isArray(x) && x.length === 3
          && x.every(v => uint(v, 0xffff_ffff)) && x[0] <= 3), 'JOB_OUTPUT');
    }
    need(r.jobs.reduce((n, x) => n + x.meshes, 0) === r.meshes
      && r.jobs.reduce((n, x) => n + x.triangles, 0) === r.triangles, 'REPLAY_COUNTS');
  }
  if (publicRelease) {
    const expected = PUBLIC_OUTPUT[publicRelease];
    need(expected && input.sha256 === PUBLIC_SHA && input.bytes === 189918 && r.meshes === 9
      && r.triangles === expected[0] && r.convertedMeshMultisetSha256 === expected[1], 'PUBLIC_GROUND_TRUTH');
  }
  if (baseline) {
    need(['meshes', 'triangles', 'convertedMeshes', 'convertedTriangles', 'raw24MeshMultisetSha256',
      'convertedMeshMultisetSha256'].every(k => r[k] === baseline[k]), 'SAME_RELEASE_OUTPUT');
    if (!diagnostic) need(['log', 'info', 'warn', 'error', 'debug'].every(k => logs[k] === baseline.libraryLogLines[k]),
      'SAME_RELEASE_ORDINARY_LOGS');
  }
}

async function main() {
  const selfCheck = process.argv.length === 5 && process.argv[4] === '--public-self-check';
  need((process.argv.length === 4 || selfCheck) && Number(process.versions.node.split('.')[0]) === 24, 'USAGE_NODE24');
  const bundle = await realpath(join(fileURLToPath(new URL('.', import.meta.url))));
  const inputPath = await realpath(resolve(process.argv[2]));
  const requestedOutput = resolve(process.argv[3]);
  const output = join(await realpath(dirname(requestedOutput)), basename(requestedOutput));
  const bundleRelative = relative(bundle, output);
  need(bundleRelative !== '' && (bundleRelative.startsWith('..' + sep) || isAbsolute(bundleRelative)), 'OUTPUT_OUTSIDE_BUNDLE');
  const inputStat = await lstat(inputPath);
  need(inputStat.isFile() && inputStat.size > 0 && inputStat.size <= 0xffff_ffff, 'INPUT_FILE');
  await mkdir(output, { recursive: false });
  const started = performance.now();
  const summary = { schemaVersion: 'csg-work-local-report-v1', status: 'REFUSED',
    scope: 'POSITIVE_WRAPPER_OBSERVATIONS_ONLY_NO_TIMING_COMPLETE_CENSUS_OR_PRIVATE_CAUSE', results: [] };
  try {
    const verified = await verifyBundle(bundle);
    summary.manifestSha256 = verified.manifestSha256;
    const input = { bytes: inputStat.size, sha256: await fileHash(inputPath) };
    if (selfCheck) need(input.sha256 === PUBLIC_SHA && input.bytes === 189918, 'PUBLIC_INPUT');
    const baselines = new Map();
    for (const release of [6, 7]) for (const [variant, mode] of [['stock', 'ordinary'], ['on', 'ordinary'], ['on', 'diagnostic']]) {
      need(performance.now() - started < 900_000, 'GLOBAL_DEADLINE');
      const role = `release${release}-${variant}`, name = `${role}-${mode}`;
      const paths = verified.manifest.projects[role], pins = {};
      for (const [key, field] of [['geometryEntry', 'geometryEntrySha256'], ['wasmGlue', 'wasmGlueSha256'], ['wasmBinary', 'wasmSha256']]) {
        pins[field] = verified.indexed.get(`projects/${role}/${paths[key]}`).sha256;
      }
      let observation;
      try {
        observation = await runChild([join(bundle, 'csg-work-diagnostic.mjs'), mode, inputPath],
          { cwd: join(bundle, 'projects', role), timeoutMs: Math.min(180_000, 900_000 - (performance.now() - started)) });
      } catch (error) {
        if (error.observation) {
          await persistAttempt(output, name, error.observation);
        }
        throw error;
      }
      await persistAttempt(output, name, observation);
      const report = JSON.parse(observation.stdout.toString('utf8'));
      validateReport(report, { mode, input, pins, baseline: baselines.get(release), publicRelease: selfCheck ? release : null });
      await persistAttempt(output, name, observation, report);
      if (variant === 'stock') baselines.set(release, report);
      summary.results.push({ name, observedClose: observation.observedClose, exitCode: observation.code,
        stderrBytes: observation.stderrBytes, report });
    }
    need(await fileHash(inputPath) === input.sha256 && (await lstat(inputPath)).size === input.bytes, 'INPUT_CHANGED');
    need((await verifyBundle(bundle)).manifestSha256 === summary.manifestSha256, 'BUNDLE_CHANGED');
    need(performance.now() - started <= 900_000, 'GLOBAL_DEADLINE');
    summary.status = 'OUTPUT_IDENTITIES_MATCH_OBSERVATIONS_POSITIVE_ONLY';
  } catch (error) {
    summary.refusal = error instanceof Error && /^REFUSE [A-Z0-9_]+$/.test(error.message)
      ? error.message : 'REFUSE EXECUTION_OR_SCHEMA';
    process.exitCode = 1;
  } finally {
    await writeFile(join(output, 'report.json'), JSON.stringify(summary, null, 2) + '\n');
  }
  process.stdout.write(JSON.stringify({ status: summary.status, completedControls: summary.results.length,
    ...(summary.refusal ? { refusal: summary.refusal } : {}) }) + '\n');
}
if (isMainEntry(import.meta.url)) {
  main().catch(() => { process.stderr.write('REFUSE LAUNCHER_SETUP\n'); process.exitCode = 1; });
}
