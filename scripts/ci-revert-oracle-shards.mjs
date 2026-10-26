#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shard plan and coverage verdict for the revert-oracle lane (#7955).
 *
 * A stacked PR can select dozens of independent mutation oracles, each about
 * seven minutes of two cargo builds; run one after another they exceeded the
 * lane's timeout. The oracle step's script numbers every invocation through
 * `run_oracle`, and shard k of S runs invocation i when (i - 1) % S == k - 1.
 *
 *   plan    executes that SAME script, read from test.yml, with
 *           REVERT_ORACLE_PLAN=1: `run_oracle` only numbers invocations and
 *           every positive side (`after_oracle`) is skipped. It emits the
 *           total, and refuses a total the fixed SHARDS x PER_SHARD cannot
 *           hold. The matrix is a fixed inline list because the review-signal
 *           gate derives every published check name from it; shards numbered
 *           past the total run no oracle and only write their ledger.
 *   verify  fails unless every shard left a complete ledger, every ledger
 *           counted the same total as the plan, and every invocation 1..total
 *           ran exactly once, in the shard the rule assigns it to. A shard
 *           that silently skipped, or an invocation nobody ran, is a failure:
 *           coverage cannot drop by sharding.
 */

import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from './lib/is-main-entry.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WORKFLOW = '.github/workflows/test.yml';
export const STEP_NAME = 'Prove the changed tests observe the production change';
/** Most oracles one shard may run: the step timeout in test.yml is this times the per-case bound. */
export const PER_SHARD = 4;
/** The inline `shard: [1..SHARDS]` list of the revert-oracle job in test.yml. */
export const SHARDS = 32;

/** The oracle step's `run: |` script, dedented exactly as the runner sees it. */
export function extractOracleScript(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.trim() === `- name: ${STEP_NAME}`);
  if (at < 0) throw new Error(`no step named "${STEP_NAME}" in ${WORKFLOW}`);
  const stepIndent = lines[at].indexOf('-');
  let run = -1;
  for (let i = at + 1; i < lines.length; i++) {
    const indent = lines[i].search(/\S/);
    if (indent >= 0 && indent <= stepIndent) break;
    if (lines[i].trim() === 'run: |') { run = i; break; }
  }
  if (run < 0) throw new Error(`step "${STEP_NAME}" has no literal run block`);
  const body = [];
  let indent = -1;
  for (let i = run + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') { body.push(''); continue; }
    const own = line.search(/\S/);
    if (indent < 0) indent = own;
    if (own < indent) break;
    body.push(line.slice(indent));
  }
  while (body.length && body.at(-1) === '') body.pop();
  if (!body.some((line) => /^\s*run_oracle\b/.test(line))) {
    throw new Error(`step "${STEP_NAME}" invokes no run_oracle: sharding would plan nothing`);
  }
  return `${body.join('\n')}\n`;
}

/** Length of the revert-oracle job's inline `shard: [1, ..., n]` list (must be exactly 1..n). */
export function shardList(text) {
  const job = /^ {2}revert-oracle:\n([\s\S]*?)(?=\n {2}\S|(?![\s\S]))/m.exec(text);
  const list = job && /^ {8}shard: \[([^\]]*)\]$/m.exec(job[1]);
  if (!list) throw new Error(`no inline shard list in the revert-oracle job of ${WORKFLOW}`);
  const values = list[1].split(',').map((value) => Number(value.trim()));
  if (!values.every((value, index) => value === index + 1)) throw new Error(`shard list must be 1..n, got [${list[1]}]`);
  return values.length;
}

/** Parse a ledger: `ran <i>` per executed invocation, then `total <n>`. */
export function parseLedger(text) {
  const ran = [];
  let total = null;
  for (const line of text.split('\n')) {
    const value = line.trim();
    if (!value) continue;
    const match = /^(ran|total) (\d+)$/.exec(value);
    if (!match) throw new Error(`malformed ledger line: ${value}`);
    if (match[1] === 'ran') ran.push(Number(match[2]));
    else if (total !== null) throw new Error('ledger has two totals');
    else total = Number(match[2]);
  }
  return { ran, total };
}

/** Throws unless `total` fits the fixed matrix at PER_SHARD oracles per shard. */
export function checkCapacity(total, shards = SHARDS) {
  if (!Number.isInteger(total) || total < 1) throw new Error(`a plan must number at least one oracle, got ${total}`);
  if (total > shards * PER_SHARD) {
    throw new Error(`${total} oracles exceed ${shards} shards x ${PER_SHARD}: extend the shard list in ${WORKFLOW} and SHARDS`);
  }
  return total;
}

export const shardOf = (index, shards) => ((index - 1) % shards) + 1;

/** @param ledgers Map<shard number, ledger text | undefined> */
export function verify({ total, shards, ledgers }) {
  const errors = [];
  try { checkCapacity(total, shards); } catch (error) { errors.push(error.message); }
  const runs = new Map();
  for (let shard = 1; shard <= shards; shard++) {
    const text = ledgers.get(shard);
    if (text === undefined) { errors.push(`shard ${shard}: no ledger (the shard did not complete)`); continue; }
    let ledger;
    try { ledger = parseLedger(text); } catch (error) { errors.push(`shard ${shard}: ${error.message}`); continue; }
    if (ledger.total === null) errors.push(`shard ${shard}: ledger has no total (the script did not finish)`);
    else if (ledger.total !== total) errors.push(`shard ${shard}: numbered ${ledger.total} oracles, the plan numbered ${total}`);
    for (const index of ledger.ran) {
      if (index < 1 || index > total) errors.push(`shard ${shard}: ran unplanned oracle ${index}`);
      else if (shardOf(index, shards) !== shard) errors.push(`shard ${shard}: ran oracle ${index}, assigned to shard ${shardOf(index, shards)}`);
      runs.set(index, [...(runs.get(index) ?? []), shard]);
    }
  }
  for (const extra of [...ledgers.keys()].filter((shard) => shard < 1 || shard > shards)) {
    errors.push(`ledger from unplanned shard ${extra}`);
  }
  for (let index = 1; index <= total; index++) {
    const by = runs.get(index) ?? [];
    if (by.length === 0) errors.push(`oracle ${index} was not run by any shard`);
    if (by.length > 1) errors.push(`oracle ${index} ran ${by.length} times (shards ${by.join(', ')})`);
  }
  return errors;
}

/** Run the step script in plan mode and return how many oracles it numbers. */
export function planTotal(script, cwd = ROOT) {
  const scratch = mkdtempSync(join(tmpdir(), 'revert-oracle-plan-'));
  try {
    const ledger = join(scratch, 'ledger.txt');
    const result = spawnSync('bash', ['-e', '-c', script], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, REVERT_ORACLE_PLAN: '1', REVERT_ORACLE_LEDGER: ledger },
    });
    if (result.status !== 0) throw new Error(`plan-mode script exited ${result.status ?? result.signal}`);
    const { ran, total } = parseLedger(existsSync(ledger) ? readFileSync(ledger, 'utf8') : '');
    if (ran.length) throw new Error(`plan mode executed ${ran.length} oracle(s)`);
    if (total === null) throw new Error('plan-mode script wrote no total');
    return total;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function output(values) {
  for (const [key, value] of Object.entries(values)) {
    console.log(`${key}=${value}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'plan') {
    const text = readFileSync(join(ROOT, WORKFLOW), 'utf8');
    const listed = shardList(text);
    if (listed !== SHARDS) throw new Error(`${WORKFLOW} lists ${listed} revert-oracle shards, SHARDS is ${SHARDS}`);
    const total = checkCapacity(planTotal(extractOracleScript(text)));
    output({ total });
    return;
  }
  if (command === 'verify') {
    const { total, shards, dir } = args(rest);
    const ledgers = new Map();
    for (let shard = 1; shard <= Number(shards); shard++) {
      const file = join(dir, `revert-oracle-ledger-${shard}`, 'ledger.txt');
      if (existsSync(file)) ledgers.set(shard, readFileSync(file, 'utf8'));
    }
    const errors = verify({ total: Number(total), shards: Number(shards), ledgers });
    if (errors.length) {
      console.error(`❌ revert-oracle shards do not cover the plan:\n${errors.map((e) => `   - ${e}`).join('\n')}`);
      process.exit(1);
    }
    console.log(`✔ all ${total} revert oracles ran exactly once across ${shards} shard(s)`);
    return;
  }
  console.error('usage: ci-revert-oracle-shards.mjs plan | verify --total N --shards S --dir DIR');
  process.exit(2);
}

if (isMainEntry(import.meta.url)) main();
