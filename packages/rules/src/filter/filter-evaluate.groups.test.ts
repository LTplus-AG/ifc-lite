/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `evaluateFilterGroupsFederated` on real fixtures (#4904): a `+` union of
 * two class groups (`IfcWall` OR `IfcDoor`) must count exactly as many
 * elements as the sum of the two single-group runs — nothing double-counted
 * (the two classes are disjoint) and nothing dropped (each group still gets
 * its own AND+`op:in` index prefilter, see `filter-evaluate.ts`'s "Group
 * evaluation" section).
 *
 * Skips (never fails) when a fixture is absent; CI fetches both via
 * `pnpm fixtures`. Both fixtures are already in `tests/models/manifest.json`
 * (asserted below so a missing manifest entry fails loudly instead of this
 * suite silently going vacuous).
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { evaluateFilterGroupsFederated } from './filter-evaluate-groups.js';
import { evaluateFilterRulesFederated, type EvaluatorModel } from './filter-evaluate.js';
import { Rule } from './filter-rules.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

// Per-fixture class pair: both classes must actually be present (and
// disjoint) in that fixture, or the test cannot exercise a real union —
// `hello-wall` carries no IfcDoor, so `IfcWall + IfcDoor` alone won't do.
const FIXTURES = [
  { path: 'tests/models/ifc5/Hello_Wall_hello-wall.ifc', classA: 'IfcWall', classB: 'IfcWindow' },
  { path: 'tests/models/buildingsmart/Building-Architecture.ifc', classA: 'IfcWall', classB: 'IfcSlab' },
] as const;

async function parseStore(path: string): Promise<IfcDataStore> {
  const bytes = readFileSync(join(REPO_ROOT, path));
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
}

describe('evaluateFilterGroupsFederated — fixture-backed union count (#4904)', () => {
  for (const { path, classA, classB } of FIXTURES) {
    it(`${path}: "${classA} + ${classB}" counts the sum of the two single-group runs`, async (t) => {
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'tests', 'models', 'manifest.json'), 'utf8')) as {
        files: { path: string }[];
      };
      assert.ok(
        manifest.files.some((f) => `tests/models/${f.path}` === path),
        `${path} is not in tests/models/manifest.json, so CI would never fetch it`,
      );
      if (!existsSync(join(REPO_ROOT, path))) {
        t.skip('run pnpm fixtures for the real union-count fixture');
        return;
      }

      const store = await parseStore(path);
      const models: EvaluatorModel[] = [{ id: 'm1', store }];
      const NO_CAP = { limit: Number.MAX_SAFE_INTEGER };

      const as_ = await evaluateFilterRulesFederated(models, [Rule.ifcType([classA])], 'AND', NO_CAP);
      const bs = await evaluateFilterRulesFederated(models, [Rule.ifcType([classB])], 'AND', NO_CAP);
      // The fixture actually has to exercise both sides, or this test cannot
      // fail the way it claims to (an all-zero union trivially "sums").
      assert.ok(as_.length > 0, `${path} has no ${classA} — fixture cannot exercise the union`);
      assert.ok(bs.length > 0, `${path} has no ${classB} — fixture cannot exercise the union`);

      const union = await evaluateFilterGroupsFederated(
        models,
        [
          { rules: [Rule.ifcType([classA])], combinator: 'AND' },
          { rules: [Rule.ifcType([classB])], combinator: 'AND' },
        ],
        NO_CAP,
      );

      assert.strictEqual(union.length, as_.length + bs.length);
      // Disjoint classes: no (modelId, expressId) pair appears in both sides,
      // so de-duplication across groups (see `groupKey` in filter-evaluate.ts)
      // never had anything to actually dedupe here — the sum check above is
      // the real assertion; this rules out a union that silently unioned
      // (rather than summed) by coincidence.
      const aIds = new Set(as_.map((w) => w.expressId));
      const bIds = new Set(bs.map((d) => d.expressId));
      assert.strictEqual([...aIds].filter((id) => bIds.has(id)).length, 0);
    });
  }
});
