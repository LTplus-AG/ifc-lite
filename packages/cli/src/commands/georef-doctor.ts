/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite georef check` and `ifc-lite georef fix` (= `check --fix`): the
 * georeferencing doctor over `bim.georef.check()` / `planFixes()` / `fix()`.
 *
 * `fix` applies only the fixes the plan marks `ready` (write API, nothing
 * left for the user to supply, no checker caveat), prints exactly what each
 * changes, verifies the written bytes read back as intended, writes a new
 * file (`--out`) and checks that file again to show what remains.
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { extractGeoreferencingOnDemand, parseModel } from '@ifc-lite/parser';
import { readGeoreferencing, type GeorefCheckReport, type GeorefFixPlan } from '@ifc-lite/sdk';
import { createHeadlessContext } from '../loader.js';
import { fatal, printJson } from '../output.js';
import { GeorefUsageError } from './georef-args.js';
import { describeReport, writeFields } from './georef-doctor-format.js';
import { assertDistinctOutput, verifySiteWrites } from './georef-doctor-verify.js';
import { verifyWritten } from './georef-format.js';

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 } as const;
const FAIL_ON = ['error', 'warning', 'info', 'none'] as const;
type FailOn = (typeof FAIL_ON)[number];

const VALUE_FLAGS = new Set(['--out', '--fail-on', '--apply', '--value']);
const BOOLEAN_FLAGS = new Set(['--json', '--allow-network', '--fix', '--accept-approximate-datum', '--dry-run']);
const VALUE_PATH = /^(ProjectedCRS|MapConversion|IfcSite)\.[A-Za-z]+$/;

interface DoctorArgs {
  file: string;
  json: boolean;
  allowNetwork: boolean;
  fix: boolean;
  dryRun: boolean;
  acceptApproximateDatum: boolean;
  out?: string;
  failOn: FailOn;
  apply: string[];
  values: Record<string, string | number>;
}

function parseDoctorArgs(args: string[], subcommand: 'check' | 'fix'): DoctorArgs {
  const positionals: string[] = [];
  const booleans = new Set<string>();
  const single = new Map<string, string>();
  const apply: string[] = [];
  const values: Record<string, string | number> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    if (BOOLEAN_FLAGS.has(arg)) { booleans.add(arg); continue; }
    if (!VALUE_FLAGS.has(arg)) throw new GeorefUsageError(`Unknown or unsupported option for georef ${subcommand}: ${arg}`);
    if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new GeorefUsageError(`${arg} needs a value`);
    const value = args[++i];
    if (arg === '--apply') apply.push(value);
    else if (arg === '--value') {
      const eq = value.indexOf('=');
      const path = eq < 0 ? '' : value.slice(0, eq);
      if (!VALUE_PATH.test(path)) throw new GeorefUsageError(`--value takes PATH=VALUE with PATH like ProjectedCRS.Name, MapConversion.Eastings or IfcSite.RefLatitude; got ${JSON.stringify(value)}`);
      const raw = value.slice(eq + 1);
      if (path.startsWith('ProjectedCRS.')) values[path] = raw;
      else {
        const n = raw.trim() === '' ? Number.NaN : Number(raw);
        if (!Number.isFinite(n)) throw new GeorefUsageError(`--value ${path} must be a number, got ${JSON.stringify(raw)}`);
        values[path] = n;
      }
    } else {
      if (single.has(arg)) throw new GeorefUsageError(`${arg} was given twice`);
      single.set(arg, value);
    }
  }
  if (positionals.length !== 1) throw new GeorefUsageError(`Usage: ifc-lite georef ${subcommand} <file.ifc> ...`);
  const failOn = (single.get('--fail-on') ?? 'error') as FailOn;
  if (!FAIL_ON.includes(failOn)) throw new GeorefUsageError(`--fail-on must be one of: ${FAIL_ON.join(', ')}`);
  const fix = subcommand === 'fix' || booleans.has('--fix');
  if (!fix && (apply.length || Object.keys(values).length || single.has('--out') || booleans.has('--dry-run') || booleans.has('--accept-approximate-datum'))) {
    throw new GeorefUsageError('--out, --apply, --value, --dry-run and --accept-approximate-datum belong to georef fix (or check --fix)');
  }
  if (fix && !booleans.has('--dry-run') && !single.has('--out')) throw new GeorefUsageError('georef fix writes a new file: pass --out F (or --dry-run to only show the plan)');
  const out = single.get('--out');
  if (out !== undefined && resolve(out) === resolve(positionals[0])) {
    throw new GeorefUsageError('georef fix never overwrites its input: pass a different --out path');
  }
  return {
    file: positionals[0], json: booleans.has('--json'), allowNetwork: booleans.has('--allow-network'), fix,
    dryRun: booleans.has('--dry-run'), acceptApproximateDatum: booleans.has('--accept-approximate-datum'),
    out: single.get('--out'), failOn, apply, values,
  };
}

/** 1 when a finding at or above the threshold exists, else 0. */
function exitCode(report: GeorefCheckReport, failOn: FailOn): 0 | 1 {
  if (failOn === 'none') return 0;
  return report.findings.some((f) => SEVERITY_RANK[f.severity] <= SEVERITY_RANK[failOn]) ? 1 : 0;
}


export async function georefCheckCommand(args: string[]): Promise<void> {
  const parsed = parseDoctorArgs(args, 'check');
  if (parsed.fix) return runFix(parsed);
  const { bim } = await createHeadlessContext(parsed.file);
  const report = await bim.georef.check({ allowNetwork: parsed.allowNetwork });
  const plan = bim.georef.planFixes(report);
  if (parsed.json) printJson({ file: parsed.file, report: report, plan });
  else process.stdout.write(describeReport(parsed.file, report, plan));
  process.exitCode = exitCode(report, parsed.failOn);
}

export async function georefFixCommand(args: string[]): Promise<void> {
  return runFix(parseDoctorArgs(args, 'fix'));
}

async function runFix(parsed: DoctorArgs): Promise<void> {
  const { bim, store } = await createHeadlessContext(parsed.file);
  const report = await bim.georef.check({ allowNetwork: parsed.allowNetwork });
  let plan: GeorefFixPlan;
  try {
    plan = bim.georef.planFixes(report, { choose: parsed.apply, values: parsed.values, acceptApproximateDatum: parsed.acceptApproximateDatum });
  } catch (err) {
    if (err instanceof RangeError) fatal(err.message);
    throw err;
  }
  const ready = plan.fixes.filter((f) => f.status === 'ready');
  const unused = Object.keys(parsed.values).filter((path) => !plan.fixes.some((f) => (f.needs ?? []).some((n) => n.path === path) || writeFields(f).some(([p]) => p === path)));
  if (!parsed.json) {
    process.stdout.write(describeReport(parsed.file, report, plan));
    if (unused.length) process.stderr.write(`note: --value ${unused.join(', ')} is not asked for by any fix\n`);
  }
  if (ready.length === 0 || parsed.dryRun) {
    const why = ready.length === 0 ? 'Nothing the doctor can apply' : `Dry run: ${ready.length} fix${ready.length === 1 ? '' : 'es'} would apply`;
    if (parsed.json) printJson({ file: parsed.file, report: report, plan, applied: [], output: null });
    else process.stdout.write(`\n  ${why}; no file written.\n`);
    process.exitCode = exitCode(report, parsed.failOn);
    return;
  }

  const result = bim.georef.fix(plan);
  const intended = bim.georef.get();
  const text = String(bim.export.ifc(undefined, { schema: store.schemaVersion as 'IFC2X3' | 'IFC4' | 'IFC4X3' }));
  const { store: written } = await parseModel(new TextEncoder().encode(text), { disableWorkerScan: true });
  const mismatches = result.writes.some((w) => w.via !== 'georef.site')
    ? verifyWritten(intended, readGeoreferencing(written), extractGeoreferencingOnDemand(written))
    : [];
  mismatches.push(...verifySiteWrites(written, plan));
  if (mismatches.length > 0) fatal(`The written file does not read back as the fixes intended; nothing was saved:\n  ${mismatches.join('\n  ')}`);
  await assertDistinctOutput(parsed.file, parsed.out as string);
  await writeFile(parsed.out as string, text, 'utf-8');

  // Check the file as written, from disk, with the same capabilities.
  const { bim: after } = await createHeadlessContext(parsed.out as string);
  const recheck = await after.georef.check({ allowNetwork: parsed.allowNetwork });
  const site = plan.fixes.find((f) => f.status === 'ready' && f.write?.via === 'georef.site')?.write;
  if (site?.via === 'georef.site') {
    const read = recheck.facts.siteLocation;
    const off = (want: number | undefined, got: number | undefined) => want !== undefined && (got === undefined || Math.abs(want - got) > 1e-6);
    if (!read || off(site.input.RefLatitude, read.latitude) || off(site.input.RefLongitude, read.longitude)) {
      fatal(`${parsed.out} was written, but its IfcSite RefLatitude/RefLongitude does not read back as ${site.input.RefLatitude}, ${site.input.RefLongitude}.`);
    }
  }
  const remainingPlan = after.georef.planFixes(recheck);
  if (parsed.json) {
    printJson({ file: parsed.file, output: parsed.out, applied: result.applied, notes: result.writes.flatMap((w) => w.notes), report: report, plan, after: { report: recheck, plan: remainingPlan } });
  } else {
    const lines = ['', `  Applied ${result.applied.join(', ')}; wrote ${parsed.out}.`];
    for (const note of result.writes.flatMap((w) => w.notes)) lines.push(`  note: ${note}`);
    lines.push('', `  Check of ${parsed.out}:`);
    process.stdout.write(lines.join('\n') + '\n');
    process.stdout.write(recheck.findings.length === 0 ? '  No findings.\n' : describeReport(parsed.out as string, recheck, remainingPlan));
  }
  process.exitCode = exitCode(recheck, parsed.failOn);
}
