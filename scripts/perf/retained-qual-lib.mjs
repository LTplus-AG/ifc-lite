/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Shared helpers for the #7955 retained qualification runners (README:
// scripts/perf/retained-qual.md). Row shape and statistics follow
// scripts/perf/ab-report.mjs: a JSONL row per sample with `side`
// ('base'|'branch'), `path`, `round`, `*Ms` phases and integer count
// fingerprints; MEDIAN and spread-percent as the noise floor.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus, homedir, hostname, loadavg, platform, arch, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCHEMA = 'ifc-lite.retained-qual/1';
/**
 * Where `pop-quiet-window-*.json` markers live; an unreleased one blocks work on the shared timing host.
 * `IFC_QUIET_WINDOW_DIR` overrides it (the cohort scripts check the same files before submitting).
 */
export const QUIET_WINDOW_DIR = process.env.IFC_QUIET_WINDOW_DIR ?? join(homedir(), '.t3', 'artifacts');

export function parseArgs(argv, { values = [], repeated = [], flags = [] }) {
  const out = Object.fromEntries(repeated.map(name => [name, []]));
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { rest.push(...argv.slice(i + 1)); break; }
    const name = arg.startsWith('--') ? arg.slice(2) : null;
    if (name && flags.includes(name)) out[name] = true;
    else if (name && (values.includes(name) || repeated.includes(name))) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`--${name} requires a value`);
      if (repeated.includes(name)) out[name].push(value); else out[name] = value;
    } else if (name) throw new Error(`Unknown option ${arg}`);
    else rest.push(arg);
  }
  return { options: out, rest };
}

export function sha256Bytes(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function sha256File(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', fail).on('end', () => done(hash.digest('hex')));
  });
}

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
/** The commit under measurement; `dirty` is recorded, never hidden. */
export function gitIdentity(root) {
  const commit = git(root, 'rev-parse', 'HEAD');
  return { root: resolve(root), commit, tree: git(root, 'rev-parse', 'HEAD^{tree}'), dirty: git(root, 'status', '--porcelain').length > 0 };
}

/** Host identity without secrets: the machine id is only ever recorded hashed. */
export function hostIdentity() {
  const machine = ['/etc/machine-id', '/var/lib/dbus/machine-id'].find(existsSync);
  const [load1, load5] = loadavg();
  return { hostname: hostname(), platform: platform(), arch: arch(), kernel: release(),
    cpuModel: cpus()[0]?.model ?? null, cpuCount: cpus().length, memTotalBytes: totalmem(), node: process.version,
    machineIdSha256: machine ? sha256Bytes(readFileSync(machine, 'utf8').trim()) : null, loadAtStart: { load1, load5 } };
}

/** Every unreleased quiet window blocks work on Pop. */
export function unreleasedQuietWindows(dir = QUIET_WINDOW_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => /^pop-quiet-window-.*\.json$/.test(name)).map(name => join(dir, name)).filter(path => {
    const window = JSON.parse(readFileSync(path, 'utf8'));
    return !(window.released === true || window.status === 'released');
  });
}

/**
 * The staged retained engine under measurement, validated by the SAME function the
 * CLI uses (inventory and per-asset hashes), loaded from that checkout's build.
 * An engine that does not validate is a failure, never a fallback to exact.
 */
export async function engineIdentity(checkout, directory) {
  const module = join(resolve(checkout), 'packages/cli/dist/retained/engine.js');
  if (!existsSync(module)) throw new Error(`CLI not built (missing ${module}); build @ifc-lite/cli first`);
  const { validateEngine } = await import(pathToFileURL(module).href);
  const engine = await validateEngine(directory);
  const manifest = JSON.parse(readFileSync(join(engine.directory, 'engine-manifest.json'), 'utf8'));
  return { directory: engine.directory, manifestSha256: engine.manifestSha256, sdkRevision: manifest.sdk.revision,
    assetCount: manifest.assets.length, assetBytes: manifest.assets.reduce((sum, a) => sum + a.bytes, 0), assets: manifest.assets };
}

/** `--arm SIDE:CHECKOUT:ENGINE`; one arm is a plain observation, two a balanced paired A/B. */
export function parseArms(specs, defaults = {}) {
  const arms = specs.map(spec => {
    const [side, checkout, engine, extra] = spec.split(':');
    if ((side !== 'base' && side !== 'branch') || !checkout || !engine || extra !== undefined || !checkout.startsWith('/') || !engine.startsWith('/')) {
      throw new Error(`--arm expects SIDE:/abs/checkout:/abs/engine with SIDE base|branch (got ${spec})`);
    }
    return { side, checkout, engine };
  });
  if (arms.length === 0 && defaults.checkout && defaults.engine) arms.push({ side: 'branch', checkout: defaults.checkout, engine: defaults.engine });
  if (arms.length === 0 || arms.length > 2 || new Set(arms.map(a => a.side)).size !== arms.length) {
    throw new Error('Give one --arm (observation) or exactly one base and one branch --arm (paired A/B)');
  }
  return arms;
}

// Same statistics as scripts/perf/ab-report.mjs (kept in step by retained-qual-report.test.mjs).
export const median = xs => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const spreadPct = xs => {
  if (xs.length < 2) return 0;
  const med = median(xs);
  return med <= 0 ? 0 : ((Math.max(...xs) - Math.min(...xs)) / med) * 100;
};
export function summarize(values) {
  return values.length ? { n: values.length, median: median(values), min: Math.min(...values), max: Math.max(...values), spreadPct: spreadPct(values) } : null;
}

/** Per-(arm, fixture) summaries of every numeric `*Ms`/memory column over the OK rows. */
export function summarizeRows(rows, columns) {
  const out = {};
  for (const row of rows.filter(r => r.ok)) {
    const group = (out[`${row.side}/${row.path}`] ??= { side: row.side, path: row.path, samples: 0, columns: {} });
    group.samples++;
    for (const column of columns) if (Number.isFinite(row[column])) (group.columns[column] ??= []).push(row[column]);
  }
  for (const group of Object.values(out)) group.columns = Object.fromEntries(Object.entries(group.columns).map(([k, v]) => [k, summarize(v)]));
  return out;
}

/**
 * Pinned {candidates, published} for a fixture, from a prior correctness run: flat `{name: pin}`, or per side
 * `{base: {name: pin}, branch: {name: pin}}` when the arms legitimately publish different counts.
 */
export function pinFor(pins, side, name) {
  return pins?.[side]?.[name] ?? (pins?.base || pins?.branch ? undefined : pins?.[name]);
}

/**
 * Exclusive only when the admission environment (`IFC_WORKER_KIND=benchmark`, set by ifc-fleet for
 * `--kind benchmark` jobs) or the submitter (`--exclusive-receipt`) says so; never inferred from the
 * host or the load, and never `verified` here. A flag that contradicts an ordinary job is refused,
 * so an ordinary-admission smoke cannot be mislabelled.
 */
export function exclusivity(options, env = process.env) {
  const kind = env.IFC_WORKER_KIND ?? null, job = env.IFC_WORKER_JOB_ID ?? null;
  const claimed = options['exclusive-receipt'];
  if (claimed && kind && kind !== 'benchmark') throw new Error(`--exclusive-receipt contradicts this job's admission kind ${kind}`);
  if (claimed || kind === 'benchmark') {
    return { exclusive: true, receipt: claimed ?? job, source: claimed ? '--exclusive-receipt' : 'IFC_WORKER_KIND=benchmark', jobId: job, workerKind: kind,
      verified: false, note: 'declared by the submitter or admission environment; not verified by this runner' };
  }
  return { exclusive: false, workerKind: kind, jobId: job, note: 'non-exclusive observation; not benchmark evidence' };
}

/** Writes `runs.jsonl` (ab-report row convention) and `result.json`; returns the result object. */
export function writeResult(out, result, rows) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'runs.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

export function resultEnvelope({ kind, options, arms, identities, fixtures, started }) {
  return { schema: SCHEMA, kind, reportOnly: true, performanceVerdict: 'report-only: no retained performance or memory threshold is registered',
    exclusivity: exclusivity(options), startedAt: new Date(started).toISOString(), finishedAt: null,
    host: hostIdentity(), source: identities.map(i => i.git), arms: arms.map((arm, i) => ({ side: arm.side, commit: identities[i].git.commit,
      dirty: identities[i].git.dirty, engineManifestSha256: identities[i].engine.manifestSha256, sdkRevision: identities[i].engine.sdkRevision,
      engineAssets: identities[i].engine.assets })), commit: identities[identities.length - 1].git.commit,
    engineManifestSha256: identities[identities.length - 1].engine.manifestSha256, fixtures, rounds: null, samples: 0, failures: [], rows: 0 };
}

/** One shared order for a round: balanced and randomised for a pair (scripts/perf/ab-order.mjs). */
export async function roundSides(arms, rounds, seed) {
  const { roundOrder, seededRand } = await import('./ab-order.mjs');
  if (arms.length === 1) return Array.from({ length: rounds }, () => [arms[0].side]);
  return roundOrder(rounds, seed === undefined ? Math.random : seededRand(seed));
}
