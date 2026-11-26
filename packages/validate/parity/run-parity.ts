/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * MAD MAX parity run: our generated validators against ifcopenshell.validate
 * on the crafted broken corpus and on third-party models. Writes report.json
 * and REPORT.md next to this file.
 *
 *   pnpm --filter @ifc-lite/validate parity            # oracle from oracle-cache.json
 *   pnpm --filter @ifc-lite/validate parity --oracle   # re-run IfcOpenShell (IFCOPENSHELL_PYTHON or python)
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileSchemaIdentifier, loadSchema, releaseFor, validateStepText } from '../src/index.js';
import { compareFile, ruleTable, type Explanation, type FileComparison } from './compare.js';
import { authoringCoverage, schemaCoverage } from './coverage.js';
import { hitsTarget, type OracleFinding } from './normalize.js';
import { writeMarkdown } from './report.js';

const here = import.meta.dirname;
const repoRoot = resolve(here, '../../..');
const CACHE = join(here, 'oracle-cache.json');

interface CorpusFile {
  path: string;
  kind: FileComparison['kind'];
  targets?: string;
}

interface OracleEntry {
  sha256: string;
  findings: OracleFinding[];
  error?: string;
}

interface OracleCache {
  version: string;
  files: Record<string, OracleEntry>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function corpus(): { files: CorpusFile[]; missing: string[] } {
  const manifest = readJson<Array<{ file: string; targets: string | null }>>(join(here, 'corpus/manifest.json'));
  const files: CorpusFile[] = [
    { path: 'packages/validate/parity/corpus/base-ifc4.ifc', kind: 'crafted' },
    { path: 'packages/validate/parity/corpus/ifc4x3/base.ifc', kind: 'crafted' },
    ...manifest.map((m) => ({ path: `packages/validate/parity/corpus/${m.file}`, kind: 'crafted' as const, ...(m.targets ? { targets: m.targets } : {}) })),
  ];
  const missing: string[] = [];
  for (const path of readJson<{ files: string[] }>(join(here, 'real-models.json')).files) {
    if (existsSync(join(repoRoot, path))) files.push({ path, kind: 'real' });
    else missing.push(path);
  }
  return { files, missing };
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function refreshOracle(cache: OracleCache, files: CorpusFile[], force: boolean): OracleCache {
  const stale = files.filter((f) => force || cache.files[f.path]?.sha256 !== sha256(join(repoRoot, f.path)));
  if (!stale.length) return cache;
  if (!force) throw new Error(`Oracle cache missing or stale for ${stale.map(f => f.path).join(', ')}. Refresh with parity --oracle.`);
  const python = process.env.IFCOPENSHELL_PYTHON ?? 'python';
  const run = spawnSync(python, [join(here, 'oracle.py'), ...stale.map((f) => join(repoRoot, f.path))], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (run.status !== 0) throw new Error(`oracle failed (${python}): ${run.stderr || run.error?.message}`);
  const out = JSON.parse(run.stdout) as { version: string; files: Array<{ path: string; sha256: string; findings: OracleFinding[]; error?: string }> };
  const next: OracleCache = { version: out.version, files: { ...cache.files } };
  for (const f of out.files) {
    if (f.error) throw new Error(`Oracle failed for ${f.path}: ${f.error}`);
    const key = relative(repoRoot, f.path).replaceAll('\\', '/');
    next.files[key] = { sha256: f.sha256, findings: f.findings, ...(f.error ? { error: f.error } : {}) };
  }
  writeFileSync(CACHE, `${JSON.stringify(next, null, 1)}\n`);
  return next;
}

async function main(): Promise<void> {
  const force = process.argv.includes('--oracle');
  const { files, missing } = corpus();
  let cache: OracleCache = existsSync(CACHE) ? readJson<OracleCache>(CACHE) : { version: '', files: {} };
  cache = refreshOracle(cache, files, force);
  const explanations = readJson<{ explanations: Explanation[] }>(join(here, 'explanations.json')).explanations;

  const comparisons: FileComparison[] = [];
  for (const f of files) {
    const text = readFileSync(join(repoRoot, f.path), 'utf8');
    const started = Date.now();
    const report = await validateStepText(text);
    const ms = Date.now() - started;
    const oracle = cache.files[f.path];
    if (oracle?.error) throw new Error(`Cached oracle failed for ${f.path}: ${oracle.error}`);
    comparisons.push(compareFile(f.path, f.kind, report.schema, report.findings, oracle?.findings ?? [], ms, f.targets, oracle?.error));
  }

  const subset = readJson<{ entities: string[] }>(join(here, 'authoring-subset.json')).entities;
  const coverage = [];
  for (const release of ['IFC4', 'IFC4X3', 'IFC2X3'] as const) {
    const schema = await loadSchema(release);
    coverage.push(schemaCoverage(schema));
    if (release !== 'IFC2X3') coverage.push(authoringCoverage(schema, subset));
  }
  const crafted = comparisons.filter((c) => c.kind === 'crafted');
  const targeted = crafted.filter((c) => c.targets).map((c) => {
    const hit = (keys: string[]) => keys.some((k) => hitsTarget(k, c.targets!));
    return { file: c.path.replace('packages/validate/parity/corpus/', ''), targets: c.targets!, ours: hit([...c.tp, ...c.fp]), oracle: hit([...c.tp, ...c.fn]) };
  });
  const report = {
    generatedAt: new Date().toISOString().slice(0, 10),
    oracle: { engine: 'ifcopenshell.validate (express_rules=True)', version: cache.version },
    coverage,
    totals: {
      files: comparisons.length,
      tp: comparisons.reduce((n, c) => n + c.tp.length, 0),
      fp: comparisons.reduce((n, c) => n + c.fp.length, 0),
      fn: comparisons.reduce((n, c) => n + c.fn.length, 0),
      craftedFn: crafted.reduce((n, c) => n + c.fn.length, 0),
    },
    rules: { crafted: ruleTable(crafted, explanations), all: ruleTable(comparisons, explanations) },
    targeted,
    files: comparisons,
    missingModels: missing,
    schemaFor: Object.fromEntries(files.map((f) => [f.path, releaseFor(fileSchemaIdentifier(readFileSync(join(repoRoot, f.path), 'utf8')) ?? '') ?? 'none'])),
  };
  if (process.argv.includes('--check')) {
    const expected = readJson<{ files: FileComparison[] }>(join(here, 'report.json'));
    const baseline = new Map(expected.files.map(file => [file.path, file]));
    const actual = new Set(comparisons.map(file => file.path));
    const strict = process.env.IFC_LITE_REQUIRE_FIXTURES === '1';
    const optional = new Set(strict ? [] : missing);
    const absent = [...new Set([...(strict ? missing : []), ...[...baseline.keys()].filter(path => !actual.has(path) && !optional.has(path))])];
    const unexpected = [...actual].filter(path => !baseline.has(path));
    if (absent.length || unexpected.length) {
      throw new Error(`Parity input paths changed. Missing: ${absent.join(', ')}. Unexpected: ${unexpected.join(', ')}.`);
    }
    for (const file of comparisons) {
      const prior = baseline.get(file.path);
      if (!prior || file.oracleError) throw new Error(`No usable baseline for ${file.path}`);
      for (const key of ['tp', 'fp', 'fn'] as const) {
        if (JSON.stringify([...file[key]].sort()) !== JSON.stringify([...prior[key]].sort())) {
          throw new Error(`Parity changed for ${file.path} (${key}): ${JSON.stringify(file[key])}`);
        }
      }
    }
    if (missing.length) console.log(`Skipped ${missing.length} missing models. Run pnpm fixtures for full coverage.`);
  } else {
    writeFileSync(join(here, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
    writeFileSync(join(here, 'REPORT.md'), writeMarkdown(report));
  }
  console.log(`parity: ${report.totals.files} files, TP ${report.totals.tp}, FP ${report.totals.fp}, FN ${report.totals.fn} (crafted FN ${report.totals.craftedFn})`);
}

await main();
