// SPDX-License-Identifier: MPL-2.0
// One fresh process per model; the built CLI is the output under test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { validateEngine } from '../../packages/cli/dist/retained/engine.js';
import { runRetained } from '../../packages/cli/dist/retained/run.js';
import { retainedReport } from '../../packages/cli/dist/retained/report.js';
const [directory, model, output] = process.argv.slice(2);
const engine = await validateEngine(directory);
const outcomes = await runRetained(engine, await readFile(model));
const expected = retainedReport(engine, outcomes, () => null);
const obj = join(output, 'model.obj'), report = join(output, 'report.json');
const cli = spawnSync(process.execPath, ['packages/cli/dist/index.js', 'export', model, '--format', 'obj',
  '--kernel', 'retained', '--retained-engine', directory, '--retained-report', report, '--out', obj], { encoding: 'utf8', timeout: 300000 });
if (cli.error) throw cli.error;
assert.equal(cli.status, expected.summary.published ? 0 : 1, cli.stderr);
assert.equal(cli.stdout, '', 'file export must not leak logs onto stdout');
let actual = expected;
if (expected.summary.published) {
  actual = JSON.parse(await readFile(report, 'utf8'));
  assert.deepEqual(actual.summary, expected.summary);
  assert.deepEqual(actual.products.map(({ globalId, ...p }) => p), expected.products.map(({ globalId, ...p }) => p));
  assert.match(await readFile(obj, 'utf8'), /# PresentationObligationsUnmet/);
} else {
  await assert.rejects(access(obj));
  await assert.rejects(access(report));
}
process.stdout.write(JSON.stringify(actual.products.map(p => ({ ...p, model }))));
