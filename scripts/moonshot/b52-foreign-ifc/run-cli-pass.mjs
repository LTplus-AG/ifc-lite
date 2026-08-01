#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B5.2: the shipped CLI commands, run against the foreign models.
 *
 * The kernel pass calls `computeValidationIssues` and the clash engine
 * in-process, which is literally what `ifc-lite validate` and `ifc-lite clash`
 * call - that is the documented design of tools/world-gym/lib/checks.mjs. This
 * pass runs the actual CLI binaries anyway, for two reasons the in-process
 * path cannot cover: it proves the shipped entry points survive a 1M-entity
 * delivered file, and it times the cold-start cost a user actually pays.
 *
 * PRIVACY: `ifc-lite validate --json` echoes the input path in `summary.file`,
 * `clash --json` echoes authored element names in every clash record, and the
 * clash SUMMARY carries `byStorey`, whose keys are authored storey names. None
 * of it is read out of the child's stdout: every field lifted below is named
 * explicitly, the raw stdout is never written anywhere, and the entity count
 * is bucketed before it is emitted (see lib/model-id.mjs).
 *
 * Usage:
 *   node run-cli-pass.mjs --model <abs path> --alias model-a --out <dir>
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { coarseMegabytes, coarseEntityCount, round } from './lib/model-id.mjs';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '../../../packages/cli/dist/index.js');

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const modelPath = flag('--model');
const alias = flag('--alias');
const outDir = flag('--out');
if (!modelPath || !alias || !outDir) {
  process.stderr.write('Usage: run-cli-pass.mjs --model <path> --alias <id> --out <dir>\n');
  process.exit(2);
}

const bytes = await readFile(modelPath);

async function runCli(args) {
  const t0 = performance.now();
  let stdout = '';
  let exitCode = 0;
  // `err.code` is the child's numeric exit status for a normal non-zero exit,
  // but a STRING errno ('ENOENT', 'ENOBUFS') when the spawn or the output
  // buffer failed. Collapsing both into one field made a failure to launch
  // indistinguishable from a clean exit 1, so the original is kept verbatim in
  // `errorCode` and only the numeric status lands in `exitCode`.
  let errorCode = null;
  try {
    ({ stdout } = await execFileAsync(process.execPath, ['--max-old-space-size=10240', CLI, ...args], {
      maxBuffer: 512 * 1024 * 1024,
    }));
  } catch (err) {
    stdout = err.stdout ?? '';
    errorCode = err.code ?? err.name ?? 'unknown';
    exitCode = typeof err.code === 'number' ? err.code : null;
  }
  return { ms: performance.now() - t0, exitCode, errorCode, stdout };
}

// --- ifc-lite validate ------------------------------------------------------
const v = await runCli(['validate', modelPath, '--json']);
let validate = { ok: false };
try {
  const j = JSON.parse(v.stdout);
  const ruleCounts = {};
  for (const iss of j.issues ?? []) {
    const k = `${iss.rule}/${iss.severity}`;
    ruleCounts[k] = (ruleCounts[k] ?? 0) + 1;
  }
  // `j.file` (the input path) is deliberately NOT read.
  validate = {
    ok: true,
    exitCode: v.exitCode,
    errorCode: v.errorCode,
    wallMs: round(v.ms, 1),
    schema: j.schema ?? null,
    approxEntityCount: coarseEntityCount(j.entityCount ?? null),
    valid: j.valid,
    errors: j.errors,
    warnings: j.warnings,
    info: j.info,
    issueCount: (j.issues ?? []).length,
    ruleCounts,
  };
} catch (err) {
  validate = {
    ok: false, exitCode: v.exitCode, errorCode: v.errorCode, wallMs: round(v.ms, 1), parseError: err.name,
  };
}

// --- ifc-lite clash --matrix ------------------------------------------------
const c = await runCli(['clash', modelPath, '--matrix', '--json']);
let clash = { ok: false };
try {
  const j = JSON.parse(c.stdout);
  // Individual clash records carry authored element names, and so does the
  // SUMMARY: `ClashSummary.byStorey` is keyed by authored storey name
  // (packages/clash/src/types.ts). Copying `j.summary` wholesale therefore
  // pulled authored text into a committed artifact by default, and would keep
  // doing so for any key added to that type later. Only the confirmed scalar
  // counts are lifted, by name; the open-ended maps become cardinalities.
  const s = j.summary ?? {};
  const sev = s.bySeverity ?? {};
  const count = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  clash = {
    ok: true,
    exitCode: c.exitCode,
    errorCode: c.errorCode,
    wallMs: round(c.ms, 1),
    summary: {
      total: count(s.total),
      bySeverity: {
        critical: count(sev.critical),
        major: count(sev.major),
        minor: count(sev.minor),
        info: count(sev.info),
      },
      distinctRules: Object.keys(s.byRule ?? {}).length,
      distinctTypePairs: Object.keys(s.byTypePair ?? {}).length,
    },
    recordsReturned: (j.clashes ?? []).length,
    truncated: j.truncated ? { dropped: j.truncated.dropped } : null,
  };
} catch (err) {
  clash = {
    ok: false, exitCode: c.exitCode, errorCode: c.errorCode, wallMs: round(c.ms, 1), parseError: err.name,
  };
}

const out = {
  bet: 'B5.2',
  pass: 'cli',
  alias,
  approxMegabytes: coarseMegabytes(bytes.byteLength),
  validate,
  clash,
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, `cli-${alias}.json`), `${JSON.stringify(out, null, 2)}\n`, 'utf-8');
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
