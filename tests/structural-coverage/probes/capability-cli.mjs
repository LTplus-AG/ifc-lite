/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Run the real CLI entry against the same store the read probes use (#9668). */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { boundedSpawnSync } from '../../../scripts/lib/bounded-process.mjs';
import { storeOf } from '../lib/packages.mjs';

export default {
  name: 'capability:cli-structural-command',
  level: 'capability',
  covers: (row) => row.id === 'cap/cli-structural-command',
  async run(rows, ctx) {
    const file = ctx.corpus.files.find((f) => f.path.endsWith('generated_structural_coverage_ifc2x3.ifc'));
    if (!file) return new Map(rows.map((r) => [r.id, ctx.corpus.nothingFound('carries the IFC2X3 structural coverage fixture')]));
    const build = boundedSpawnSync('pnpm', ['turbo', 'build', '--filter=@ifc-lite/cli...'],
      { cwd: ctx.root, encoding: 'utf8', timeout: 1_200_000, maxBuffer: 16 * 1024 * 1024 });
    if (build.status !== 0 || build.error) throw new Error(`CLI probe build failed: ${build.stderr || build.stdout || build.error?.message}`);
    const run = (args) => boundedSpawnSync(process.execPath,
      ['packages/cli/dist/index.js', 'structural', ...args],
      { cwd: ctx.root, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    let result;
    try {
      const data = JSON.parse(JSON.stringify(ctx.pkgs.parser.extractStructuralOnDemand(await storeOf(ctx, file))));
      const output = run([join(ctx.root, 'tests/models', file.path), '--json']);
      assert.equal(output.status, 0, output.stderr || output.error?.message);
      const got = JSON.parse(output.stdout);
      // Full records compare counts, ids, applied values, and relationship ends.
      assert.ok(data.members.length && data.activities.some((a) => a.kind === 'Action'));
      assert.deepEqual(got.members, data.members);
      assert.deepEqual(got.loads, data.activities.filter((a) => a.kind === 'Action'));
      assert.deepEqual(got.reactions, data.activities.filter((a) => a.kind === 'Reaction'));
      for (const key of ['analysisModels', 'connections', 'loadGroups', 'resultGroups']) assert.deepEqual(got[key], data[key]);
      const links = [...data.members, ...data.connections].flatMap((item) =>
        (item.physicalElementIds ?? []).map((physicalElementId) => ({ structuralItemId: item.expressId, physicalElementId })));
      assert.ok(links.length, 'fixture must exercise physical links');
      assert.deepEqual(got.links, links);
      const negative = run([]);
      assert.equal(negative.status, 1);
      assert.match(negative.stderr, /Usage: ifc-lite structural/);
      assert.equal(negative.stdout, '');
      result = { status: 'pass', evidence: [file.path] };
    } catch (error) {
      result = { status: 'fail', reason: error.message, evidence: [file.path] };
    }
    return new Map(rows.map((r) => [r.id, result]));
  },
};
