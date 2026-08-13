/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression fixture: buildingSMART's `Infra-Bridge.ifc` sample (a masonry
 * arch bridge, PCERT-Sample-Scene). Pins the CLI-default clash count on this
 * model so it cannot silently drift.
 *
 * Investigated (2026-08): the user wanted this model to report 2 clashes —
 * the two real coordination issues, an abutment support beam clashing with
 * each of the two main girders. At CLI defaults it reports 81 hard clashes,
 * 73 of which are a masonry arch bridge interpenetrating itself *by design*
 * (arch segments, spandrel walls, fillers and pierstems overlapping the way
 * a masonry arch is modelled) and 8 of which are the 2 real IfcBeam x IfcBeam
 * issues (grouping to 2 clusters at epsilon >= 2.0 m; the CLI default 1.5 m
 * epsilon splits one abutment into two clusters, a known, unchanged default).
 *
 * A same-assembly/aggregate exclusion rule was tested as a principled way to
 * drop the 73 designed-interpenetration pairs without hand-listing types:
 * across all 81 clash pairs, ZERO share a common `IfcRelAggregates` ancestor
 * (`decomposedBy` chain) — the masonry elements involved (arch segment,
 * spandrel wall, filler, girder, slab) are not `IfcElementAssembly` members
 * at all in this file; only the piers (`rail bridge - pier`, `road river
 * bridge - pier`) use `IfcRelAggregates`, and none of their parts appear in
 * any of the 81 clashing pairs. `IfcRelConnectsElements` likewise matches
 * zero pairs. "Same spatial container" (e.g. the shared `IfcBridgePart`)
 * does match 37/81 pairs, but is not a safe default: it is exactly the
 * relationship that would also suppress a wall genuinely clashing with a
 * duct in the same storey on an ordinary building model, and it does not
 * even track the real/fake split here (none of the 8 real IfcBeam x IfcBeam
 * pairs share a container). Verdict: no principled relationship-based rule
 * reaches 2 without hand-listing types; the two real issues are only
 * reachable via the existing user-defined exclusions feature (PR #2535) plus
 * `groupClashes({ by: 'cluster', epsilon: 3 })`.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { createClashEngine } from './engine.js';
import { groupClashes } from './grouping.js';
import { elementsFromStep } from './adapters/step.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '../../../tests/models/buildingsmart/Infra-Bridge.ifc');

// Fixture is fetched via `pnpm fixtures` (tests/models/manifest.json); skip
// cleanly rather than fail when it has not been pulled down.
const canRun = existsSync(FIXTURE);

describe.skipIf(!canRun)('regression: Infra-Bridge.ifc (buildingSMART sample) CLI-default clash count', () => {
  it(
    'reports 81 hard clashes at CLI defaults, 8 of them IfcBeam x IfcBeam, grouping to 2 clusters at epsilon=3m',
    async () => {
      const bytes = await readFile(FIXTURE);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

      const store = await new IfcParser().parseColumnar(buffer);

      const processor = new GeometryProcessor();
      await processor.init();
      let meshes;
      try {
        const result = await processor.process(new Uint8Array(buffer));
        meshes = result.meshes;
      } finally {
        processor.dispose();
      }

      const { elements, exclusions } = elementsFromStep({ store, meshes, modelId: 'Infra-Bridge.ifc' });

      const engine = createClashEngine({ backend: 'ts' });
      const rules = [{ id: 'cli-rule', name: '* self-clash', a: '*', mode: 'hard' as const }];
      const clashResult = await engine.run(elements, rules, { exclusions });

      expect(clashResult.summary.total).toBe(81);

      const beamBeam = clashResult.clashes.filter(
        (c) => c.a.tag === 'IfcBeam' && c.b.tag === 'IfcBeam',
      );
      expect(beamBeam).toHaveLength(8);

      // Default epsilon (1.5m) splits one abutment's beam pairs into extra
      // clusters — a known, deliberately-unchanged default. At epsilon=3m
      // (within the documented safe range [2.0, 6.5]) the 8 real pairs group
      // to the 2 real coordination issues.
      const groups = groupClashes(clashResult, { by: 'cluster', epsilon: 3 });
      const beamBeamGroups = groups.filter((g) =>
        g.members.every((c) => c.a.tag === 'IfcBeam' && c.b.tag === 'IfcBeam'),
      );
      expect(beamBeamGroups).toHaveLength(2);
    },
    120_000,
  );
});
