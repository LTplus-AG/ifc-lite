#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Modelling-parity output probes (#9296, lane L1).
 *
 * For every catalogue row whose output level applies, takes the IFC4 file its
 * SDK probe exported (`artifacts.ifc` in `$PARITY_OUT/sdk/<id>.json`) and runs:
 *   1. `node packages/cli/dist/index.js validate <file> --json`: no errors;
 *   2. a reopen: `ifc-lite run reopen.js <file>` reproduces the session's
 *      product census and the row's key classes, and a second export of the
 *      reopened model reopens with the same census;
 *   3. IfcOpenShell: `tools/ifcopenshell_reference/validate_export.py <file>`
 *      (express rules) reports no issues.
 * All three pass -> pass; some -> partial; none -> fail. When IfcOpenShell
 * cannot be imported, check 3 is SKIPPED and the row can be partial at best.
 * A row with nothing to validate (SDK probe skipped or failed, or a drawing
 * row with no UI artifact yet) reports skip with the reason, never pass.
 *
 * Usage:
 *   node tests/modelling-parity/output/run.mjs [--out DIR] [--only id,id]
 *     [--python PATH] [--build-root DIR]
 * PATH defaults to $PARITY_PYTHON, then ~/modelling-parity/venv/bin/python, then python3.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sourceInfo } from '../probes/sdk/run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const rel = (p) => relative(ROOT, p).split('\\').join('/');
const arg = (name, fallback = null) => { const i = process.argv.indexOf(name); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const OUT = resolve(arg('--out', process.env.PARITY_OUT ?? join(ROOT, 'tests/modelling-parity/.out/L1')));
const ONLY = arg('--only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const BUILD = resolve(arg('--build-root', process.env.PARITY_BUILD_ROOT ?? ROOT));
const CLI = join(BUILD, 'packages/cli/dist/index.js');
const VENV = join(homedir(), 'modelling-parity/venv/bin/python');
const PYTHON = arg('--python', process.env.PARITY_PYTHON ?? (existsSync(VENV) ? VENV : 'python3'));
const VALIDATOR = join(ROOT, 'tools/ifcopenshell_reference/validate_export.py');
const LIB = pathToFileURL(join(ROOT, 'tests/modelling-parity/probes/sdk/lib/parity.mjs')).href;

const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PARITY_ROOT: ROOT, PARITY_BUILD_ROOT: BUILD, PARITY_LIB: LIB, ...env }, maxBuffer: 1 << 26, timeout: 300000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '', error: r.error };
};
const tail = (s, n = 3) => s.trim().split('\n').slice(-n).join(' | ').slice(0, 400);

function ifcLiteValidate(file) {
  const r = run(process.execPath, [CLI, 'validate', file, '--json']);
  let summary = null;
  try { summary = JSON.parse(r.stdout); } catch { /* reported below */ }
  if (!summary) return { name: 'ifc-lite validate', status: 'fail', detail: `no JSON summary (exit ${r.code}): ${tail(r.out)}` };
  const errors = summary.issues.filter((i) => i.severity === 'error').map((i) => `${i.rule}: ${i.message}`);
  const warnings = summary.issues.filter((i) => i.severity === 'warning').map((i) => i.rule);
  return errors.length === 0
    ? { name: 'ifc-lite validate', status: 'pass', ...(warnings.length ? { warnings } : {}) }
    : { name: 'ifc-lite validate', status: 'fail', detail: `${errors.length} error(s): ${errors.slice(0, 3).join('; ')}` };
}

function census(file, reexport) {
  const r = run(process.execPath, [CLI, 'run', join(HERE, 'reopen.js'), file], reexport ? { PARITY_REEXPORT: reexport } : {});
  const line = r.stdout.match(/@@CENSUS@@(.*)/)?.[1];
  if (!line) throw new Error(`reopen failed (exit ${r.code}): ${tail(r.out)}`);
  return JSON.parse(line);
}

function reopen(file, expected, keyTypes, work, id) {
  const name = 'reopen round trip';
  try {
    const second = join(work, `${id}.reexport.ifc`);
    const first = census(file, second);
    const again = census(second);
    const diff = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => (a[k] ?? 0) !== (b[k] ?? 0)).map((k) => `${k} ${a[k] ?? 0}->${b[k] ?? 0}`);
    const lost = diff(expected ?? {}, first), drift = diff(first, again);
    const missingKeys = (keyTypes ?? []).filter((k) => !Object.keys(first).some((t) => t.replace(/StandardCase$/, '') === k));
    const problems = [
      ...(expected ? [] : ['the SDK result carries no session census to compare']),
      ...(lost.length ? [`session vs reopened census: ${lost.join(', ')}`] : []),
      ...(drift.length ? [`reopened vs re-exported census: ${drift.join(', ')}`] : []),
      ...(missingKeys.length ? [`key classes missing after reopen: ${missingKeys.join(', ')}`] : []),
    ];
    return problems.length ? { name, status: 'fail', detail: problems.join('; ') } : { name, status: 'pass', census: first };
  } catch (e) {
    return { name, status: 'fail', detail: String(e.message ?? e).slice(0, 300) };
  }
}

function ifcOpenShell(file) {
  const name = 'IfcOpenShell validate (express rules)';
  const r = run(PYTHON, [VALIDATOR, file]);
  if (r.error || r.code === 3) return { name, status: 'skip', detail: `IfcOpenShell unavailable with ${PYTHON}: ${r.error?.message ?? tail(r.out)}` };
  if (r.code === 0) return { name, status: 'pass' };
  const issues = r.out.split('\n').filter((l) => l.trim() && !/^(OK|FAIL) |validate_export\.py:/.test(l.trim())).slice(0, 3);
  return { name, status: 'fail', detail: `exit ${r.code}: ${issues.join(' | ').slice(0, 400) || tail(r.out)}` };
}

function statusOf(checks) {
  const pass = checks.filter((c) => c.status === 'pass').length;
  if (pass === checks.length) return 'pass';
  return pass > 0 ? 'partial' : 'fail';
}

async function main() {
  if (!existsSync(CLI)) { console.error(`output probes need a built CLI at ${CLI}`); process.exit(2); }
  const catalogue = JSON.parse(readFileSync(join(ROOT, 'tests/modelling-parity/catalogue.json'), 'utf8'));
  const outDir = join(OUT, 'output'), work = join(OUT, 'work');
  mkdirSync(outDir, { recursive: true });
  mkdirSync(work, { recursive: true });
  const source = sourceInfo(ROOT);
  const ios = run(PYTHON, ['-c', 'import ifcopenshell, ifcopenshell.validate; print(ifcopenshell.version)']);
  const iosVersion = ios.code === 0 ? ios.stdout.trim() : null;
  if (!iosVersion) console.error(`\n!!! IfcOpenShell is NOT importable with ${PYTHON}: every IfcOpenShell check is SKIPPED and no output row can pass.\n`);
  const counts = {};
  for (const cap of catalogue.capabilities) {
    const level = cap.probes?.output;
    if (!level?.applicable || (ONLY && !ONLY.includes(cap.id))) continue;
    if (!cap.tableStakes && !cap.probes?.sdk?.script) continue;
    const sdkFile = join(OUT, 'sdk', `${cap.id}.json`);
    const sdk = existsSync(sdkFile) ? JSON.parse(readFileSync(sdkFile, 'utf8')) : null;
    const file = sdk?.artifacts?.ifc ? join(ROOT, sdk.artifacts.ifc) : null;
    const base = { schema: 'ifclite-parity-result/1', capability: cap.id, probe: 'output', id: `output.${cap.id}`, source, runner: `node tests/modelling-parity/output/run.mjs --only ${cap.id}` };
    let result;
    if (!sdk || !file || !existsSync(file) || !['pass', 'partial'].includes(sdk.status)) {
      const why = !sdk ? 'no SDK result to take an export from'
        : cap.probes.sdk?.applicable === false ? `no headless artifact: the SDK level is ${sdk.status} for this ${cap.group === 'Documentation' ? 'documentation' : 'UI-only'} row, so the output probe needs a file from the UI probe (L4)`
          : !['pass', 'partial'].includes(sdk.status) ? `nothing to validate: the SDK probe is ${sdk.status}, so its export does not show this capability`
            : 'the SDK probe recorded no IFC export';
      result = { ...base, status: 'skip', reason: why, metrics: {}, evidence: [] };
    } else {
      const t0 = Date.now();
      const checks = [ifcLiteValidate(file), reopen(file, sdk.artifacts.census, level.keyTypes, work, cap.id), iosVersion ? ifcOpenShell(file) : { name: 'IfcOpenShell validate (express rules)', status: 'skip', detail: `IfcOpenShell not importable with ${PYTHON}` }];
      const status = statusOf(checks);
      const reason = checks.filter((c) => c.status !== 'pass').map((c) => `${c.name} ${c.status === 'skip' ? 'SKIPPED' : 'failed'}: ${c.detail}`).join('; ');
      result = { ...base, status, ...(status === 'pass' ? {} : { reason }), metrics: { ms: Date.now() - t0, ifcopenshell: iosVersion }, evidence: [rel(file)], checks };
    }
    writeFileSync(join(outDir, `${cap.id}.json`), JSON.stringify(result, null, 2) + '\n');
    counts[result.status] = (counts[result.status] ?? 0) + 1;
    console.log(`${result.status.padEnd(7)} ${cap.id}${result.reason ? ` — ${result.reason.slice(0, 200)}` : ''}`);
  }
  console.log(`\nOutput probes (IfcOpenShell ${iosVersion ?? 'MISSING'}): ${JSON.stringify(counts)} -> ${rel(outDir)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
