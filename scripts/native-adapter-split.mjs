#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The split native-adapter lane's job-to-job plumbing and verdicts
 * (geometry-platform.yml; the shape is scripts/lib/native-adapter-split.mjs).
 *
 *   pack --out DIR        native references and comparison products of this job, with sha256
 *   unpack --from DIR     restore a pack at the exact paths the consumers read; hashes verified
 *   collect --job ID --out DIR   this job's evidence for the comparison (pack + logs + step outcomes)
 *   verdict --job ID      the job's own verdict: job.status and every lane step it owns
 *   judge                 strict: every lane job succeeded (skipped is not success), one commit
 *   compare --mono DIR --split DIR [--report FILE]   both layouts, per lane (report job)
 *
 * The references live where the native tests write them: $RUNNER_TEMP (the
 * IFCLITE_*_REFERENCE files, native-references/, native-compare/) and, for
 * m7/m10, the wasm crate itself (m7_native.rs and m10_native.rs write
 * rust/wasm-bindings/*.output.json, which the browser tests fetch from the
 * crate root). An absent file is not an error here: the consumer that needs it
 * reports it, exactly as in the single job.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { judge, jobLaneSteps, SPLIT_LANE_JOBS, stepVerdict } from './lib/native-adapter-split.mjs';
import { compareLayouts } from './lib/native-adapter-split-compare.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CRATE = 'rust/wasm-bindings';
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const list = (dir, re) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && re.test(e.name)).map((e) => e.name).sort() : []);

/** [pack path, source path] of every reference and comparison product present. */
export function referenceFiles(temp, root = ROOT) {
  return [
    ...list(temp, /^m\d[\w-]*\.json$/).map((n) => [`temp/${n}`, join(temp, n)]),
    ...list(join(temp, 'native-references'), /\.json$/).map((n) => [`temp/native-references/${n}`, join(temp, 'native-references', n)]),
    ...list(join(temp, 'native-compare'), /\.(json|tsv)$/).map((n) => [`temp/native-compare/${n}`, join(temp, 'native-compare', n)]),
    ...list(join(root, CRATE), /\.output\.json$/).map((n) => [`crate/${n}`, join(root, CRATE, n)]),
  ];
}

export function pack(out, temp, root = ROOT) {
  const files = {};
  for (const [rel, source] of referenceFiles(temp, root)) {
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    copyFileSync(source, join(out, rel));
    files[rel] = sha256(source);
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify({ format: 'na-split-refs/1', files }, null, 2)}\n`);
  return files;
}

/** Restores a pack; a file whose bytes differ from the manifest is refused before anything is written. */
export function unpack(from, temp, root = ROOT) {
  const { files } = JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8'));
  for (const [rel, digest] of Object.entries(files)) {
    if (!/^(temp|crate)\/[\w./-]+$/.test(rel) || rel.includes('..')) throw new Error(`refusing pack path ${rel}`);
    if (sha256(join(from, rel)) !== digest) throw new Error(`${rel} does not match its pack manifest sha256`);
  }
  for (const rel of Object.keys(files)) {
    const target = rel.startsWith('temp/') ? join(temp, rel.slice(5)) : join(root, CRATE, rel.slice(6));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(from, rel), target);
  }
  return Object.keys(files);
}

export function collect(job, out, temp, env, root = ROOT) {
  pack(join(out, 'refs'), temp, root);
  mkdirSync(join(out, 'logs'), { recursive: true });
  for (const name of list(temp, /\.log$/)) copyFileSync(join(temp, name), join(out, 'logs', name));
  writeFileSync(join(out, 'steps.json'), env.STEPS_JSON ?? '{}');
  writeFileSync(join(out, 'meta.json'), `${JSON.stringify({ job, head: head(root), status: env.JOB_STATUS ?? null }, null, 2)}\n`);
}

const head = (root) => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

/** A lane job's own verdict: the job status (hard steps) and every lane step it owns. */
export function verdict(job, status, steps) {
  if (!SPLIT_LANE_JOBS.includes(job)) throw new Error(`unknown split job ${job}`);
  const own = stepVerdict(steps, jobLaneSteps(job));
  const problems = [...(status === 'success' ? [] : [`job status ${status}`]), ...own.missing];
  return { ok: problems.length === 0, problems };
}

function args(argv) {
  const o = {};
  for (let i = 1; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`);
    o[argv[i].slice(2)] = argv[i + 1];
  }
  return o;
}

const output = (pairs) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(pairs).map(([k, v]) => `${k}=${v}\n`).join(''));

async function main(argv) {
  const o = args(argv);
  const temp = o.temp ?? process.env.RUNNER_TEMP;
  const needTemp = () => { if (!temp) throw new Error('RUNNER_TEMP (or --temp) is required'); return temp; };
  switch (argv[0]) {
    case 'pack': console.log(`packed ${Object.keys(pack(o.out, needTemp())).length} file(s) into ${o.out}`); return 0;
    case 'unpack': console.log(`restored:\n  ${unpack(o.from, needTemp()).join('\n  ')}`); return 0;
    case 'collect': collect(o.job, o.out, needTemp(), process.env); console.log(`collected ${o.job} evidence into ${o.out}`); return 0;
    case 'verdict': {
      const steps = JSON.parse(process.env.STEPS_JSON || '{}');
      const v = verdict(o.job, process.env.JOB_STATUS, steps);
      for (const step of jobLaneSteps(o.job)) console.log(`${step}=${steps[step]?.outcome ?? 'absent'}`);
      output({ verdict: v.ok ? 'success' : 'failure', head: head(ROOT) });
      if (!v.ok) console.error(`❌ ${o.job}: ${v.problems.join('; ')}`);
      return v.ok ? 0 : 1;
    }
    case 'judge': {
      const j = judge(JSON.parse(process.env.NEEDS_JSON || '{}'));
      for (const { lane, outcome } of j.lanes) console.log(`${lane}=${outcome}`);
      if (!j.ok) console.error(`❌ split native-adapter: ${j.problems.join('; ')}`);
      return j.ok ? 0 : 1;
    }
    case 'compare': {
      const report = await compareLayouts({ mono: o.mono, split: o.split, needs: JSON.parse(process.env.NEEDS_JSON || '{}'), root: ROOT, env: process.env });
      if (o.report) writeFileSync(o.report, report.markdown);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report.markdown);
      console.log(report.markdown);
      return report.match ? 0 : 1;
    }
    default: throw new Error('usage: native-adapter-split.mjs pack|unpack|collect|verdict|judge|compare ...');
  }
}

if (isMainEntry(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.error(`❌ ${err.message}`); process.exitCode = 1; });
}
