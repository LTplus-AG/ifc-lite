#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Modelling-parity output probes (#9296, lane L1).
 *
 * For every catalogue row whose output level applies, judges the files handed
 * over by that row's passing or partial results: the SDK probe's IFC4 export
 * (`artifacts.ifc` in `$PARITY_OUT/sdk/<id>.json`) and, under the contract's
 * Handoffs section, files a UI result (probe "ui", lane L4) lists in
 * `artifacts.{ifc,svg,pdf,dxf}` or `evidence` (normally under
 * `$PARITY_OUT/artifacts/<capability-id>/`). Each handed-over set yields one
 * output result; the scorer keeps the best.
 *
 * An IFC file gets three checks:
 *   1. `node packages/cli/dist/index.js validate <file> --json`: no errors;
 *   2. a reopen: `ifc-lite run reopen.js <file>` reproduces the session's
 *      product census (when the result carries one) and keeps the row's key
 *      classes (an SDK export) or the classes the file itself contains (a UI
 *      export, which models only what its UI probe drew),
 *      and a second export of the reopened model reopens with the same census;
 *   3. IfcOpenShell: `tools/ifcopenshell_reference/validate_export.py <file>`
 *      (express rules) reports no issues.
 * An SVG, PDF or DXF file gets a SANITY check only (output/artifacts.mjs: it
 * parses, is not empty and carries linework or pages), not a validation.
 * A row's `requires` lists the kinds it needs (default: an IFC); a missing kind
 * is a failed check. All checks pass -> pass; some -> partial; none -> fail.
 * When IfcOpenShell cannot be imported its check is SKIPPED, capping the row at
 * partial. A row with nothing handed over reports skip with the reason.
 *
 * Usage:
 *   node tests/modelling-parity/output/run.mjs [--out DIR] [--only id,id]
 *     [--ui DIR[,DIR]] [--python PATH] [--build-root DIR]
 * --ui: where to look for UI results (default tests/modelling-parity/.out, all lanes).
 * PATH defaults to $PARITY_PYTHON, then ~/modelling-parity/venv/bin/python, then python3.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sourceInfo } from '../probes/sdk/run.mjs';
import { readResults } from '../score.mjs';
import { artifactSets, checkDrawing, fileClasses, requiredKinds } from './artifacts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const rel = (p) => relative(ROOT, p).split('\\').join('/');
const arg = (name, fallback = null) => { const i = process.argv.indexOf(name); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const OUT = resolve(arg('--out', process.env.PARITY_OUT ?? join(ROOT, 'tests/modelling-parity/.out/L1')));
const ONLY = arg('--only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const UI_DIRS = (arg('--ui') ?? join(ROOT, 'tests/modelling-parity/.out')).split(',').map((d) => resolve(d.trim())).filter((d) => existsSync(d));
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
    const lost = expected ? diff(expected, first) : [], drift = diff(first, again);
    const missingKeys = (keyTypes ?? []).filter((k) => !Object.keys(first).some((t) => t.replace(/StandardCase$/, '') === k));
    const problems = [
      ...(lost.length ? [`session vs reopened census: ${lost.join(', ')}`] : []),
      ...(drift.length ? [`reopened vs re-exported census: ${drift.join(', ')}`] : []),
      ...(missingKeys.length ? [`key classes missing after reopen: ${missingKeys.join(', ')}`] : []),
    ];
    if (problems.length) return { name, status: 'fail', detail: problems.join('; ') };
    return { name, status: 'pass', census: first, ...(expected ? {} : { note: 'no session census handed over: compared the reopen with its re-export only' }) };
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

let ios = null;
function ifcOpenShellVersion() {
  if (ios) return ios.version;
  const r = run(PYTHON, ['-c', 'import ifcopenshell, ifcopenshell.validate; print(ifcopenshell.version)']);
  ios = { version: r.code === 0 ? r.stdout.trim() : null };
  if (!ios.version) console.error(`\n!!! IfcOpenShell is NOT importable with ${PYTHON}: every IfcOpenShell check is SKIPPED and no IFC output row can pass.\n`);
  return ios.version;
}

function ifcChecks(file, census, keyTypes, work, tag) {
  if (!existsSync(CLI)) return [{ name: 'ifc-lite validate', status: 'fail', detail: `no built CLI at ${rel(CLI)} to validate ${rel(file)}` }];
  if (!existsSync(file)) return [{ name: 'IFC file', status: 'fail', detail: `handed-over file not found: ${file}` }];
  const v = ifcOpenShellVersion();
  return [
    ifcLiteValidate(file),
    reopen(file, census, keyTypes, work, tag),
    v ? ifcOpenShell(file) : { name: 'IfcOpenShell validate (express rules)', status: 'skip', detail: `IfcOpenShell not importable with ${PYTHON}` },
  ];
}

/** Judge one handed-over artifact set against the row's required kinds. */
function judge(cap, set, work, tag) {
  const checks = [];
  for (const group of requiredKinds(cap)) {
    if (!group.some((k) => set.files[k]?.length)) checks.push({ name: `${group.join(' or ')} file`, status: 'fail', detail: `the ${set.source} result handed over no ${group.join(' or ')} file` });
  }
  for (const [kind, files] of Object.entries(set.files)) {
    for (const [i, file] of files.entries()) {
      // SDK exports must keep the row's key classes. A UI export is judged on the classes it
      // actually contains (its own census): a UI storeys export with no walls is not a defect.
      const keyTypes = kind !== 'ifc' ? [] : set.source === 'sdk' ? cap.probes.output.keyTypes : existsSync(file) ? fileClasses(readFileSync(file, 'utf8')) : [];
      if (kind === 'ifc') checks.push(...ifcChecks(file, set.census, keyTypes, work, `${tag}${i ? `-${i}` : ''}`).map((c) => ({ ...c, file: rel(file) })));
      else checks.push({ ...checkDrawing(kind, file), file: rel(file) });
    }
  }
  return checks;
}

function skipReason(cap, sdk) {
  if (cap.probes.sdk?.applicable === false) {
    const kinds = requiredKinds(cap).map((g) => g.join('/')).join(' and ');
    return `nothing handed over: the SDK level does not apply to this ${cap.group === 'Documentation' ? 'documentation' : 'UI-only'} row and no passing or partial UI result lists a ${kinds} file under artifacts/${cap.id}/`;
  }
  if (!sdk) return 'no SDK result to take an export from';
  if (!['pass', 'partial'].includes(sdk.status)) return `nothing to validate: the SDK probe is ${sdk.status}, so its export does not show this capability`;
  return 'the SDK probe recorded no IFC export';
}

async function main() {
  const catalogue = JSON.parse(readFileSync(join(ROOT, 'tests/modelling-parity/catalogue.json'), 'utf8'));
  const outDir = join(OUT, 'output'), work = join(OUT, 'work');
  mkdirSync(outDir, { recursive: true });
  mkdirSync(work, { recursive: true });
  const source = sourceInfo(ROOT);
  const uiResults = UI_DIRS.length ? readResults(UI_DIRS).filter((r) => r.probe === 'ui') : [];
  const counts = {};
  for (const cap of catalogue.capabilities) {
    const level = cap.probes?.output;
    if (!level?.applicable || (ONLY && !ONLY.includes(cap.id))) continue;
    if (!cap.tableStakes && !cap.probes?.sdk?.script) continue;
    const sdkFile = join(OUT, 'sdk', `${cap.id}.json`);
    const sdk = existsSync(sdkFile) ? { ...JSON.parse(readFileSync(sdkFile, 'utf8')), file: rel(sdkFile) } : null;
    const sets = artifactSets([...(sdk ? [sdk] : []), ...uiResults], cap.id, { root: ROOT });
    const base = { schema: 'ifclite-parity-result/1', capability: cap.id, probe: 'output', source, runner: `node tests/modelling-parity/output/run.mjs --only ${cap.id}` };
    const results = [];
    if (!sets.length) {
      results.push({ ...base, id: `output.${cap.id}`, status: 'skip', reason: skipReason(cap, sdk), metrics: {}, evidence: [] });
    }
    for (const [n, set] of sets.entries()) {
      const t0 = Date.now();
      const id = set.source === 'sdk' ? `output.${cap.id}` : `output.${cap.id}.ui${n}`;
      const checks = judge(cap, set, work, set.source === 'sdk' ? cap.id : `${cap.id}.ui${n}`);
      const status = statusOf(checks);
      const reason = checks.filter((c) => c.status !== 'pass').map((c) => `${c.name} ${c.status === 'skip' ? 'SKIPPED' : 'failed'}: ${c.detail}`).join('; ');
      const evidence = [...new Set(Object.values(set.files).flat().map(rel))];
      results.push({ ...base, id, status, ...(status === 'pass' ? {} : { reason }), from: { probe: set.source, id: set.resultId }, metrics: { ms: Date.now() - t0, ...(ios?.version ? { ifcopenshell: ios.version } : {}) }, evidence, checks });
    }
    writeFileSync(join(outDir, `${cap.id}.json`), JSON.stringify(results.length === 1 ? results[0] : results, null, 2) + '\n');
    for (const result of results) {
      counts[result.status] = (counts[result.status] ?? 0) + 1;
      console.log(`${result.status.padEnd(7)} ${result.id}${result.reason ? ` — ${result.reason.slice(0, 200)}` : ''}`);
    }
  }
  console.log(`\nOutput probes (IfcOpenShell ${ios ? ios.version ?? 'MISSING' : 'not needed'}): ${JSON.stringify(counts)} -> ${rel(outDir)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
