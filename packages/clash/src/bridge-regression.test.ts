/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression fixture: buildingSMART's `Infra-Bridge.ifc` sample (a masonry
 * arch bridge, PCERT-Sample-Scene). Pins the CLI-default clash count on this
 * model so it cannot silently drift.
 *
 * At CLI defaults this model used to report 81 hard clashes. 31 of those were
 * never real: the narrow phase found a genuine (non-coplanar) triangle
 * crossing, but the "penetration" it measured was at or below the float32
 * precision floor for that pair's coordinate scale — bit-noise from f32
 * import (`rust/clash/src/tri_mesh.rs` ingests geometry from f32 buffers),
 * not a measured overlap. 20 of the 31 were bit-identical at
 * `-2.384185791015625e-7` (exactly the float32 ULP at magnitude `[2,4)`)
 * across unrelated element-type pairs at different physical locations —
 * the signature of a quantization floor, not independent measurements. The
 * fix (`precisionFloor` in `narrow.ts` / `precision_floor` in `narrow.rs`)
 * reclassifies a sub-floor crossing as `touch` (the surfaces genuinely are
 * in contact — that's real information) instead of `hard`; CLI-default
 * rules don't opt into `reportTouch`, so these pairs now report zero
 * clashes instead of a spurious hard one. 50 hard clashes remain: masonry
 * arch bridge elements interpenetrating by design (arch segments, spandrel
 * walls, fillers, piers), plus the 8 real `IfcBeam` x `IfcBeam` pairs
 * (2 real abutment-support-beam coordination issues, grouping to 2 clusters
 * at epsilon >= 2.0 m; the CLI default 1.5 m epsilon splits one abutment
 * into two clusters, a known, unchanged default).
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
    'reports 50 hard clashes at CLI defaults, 8 of them IfcBeam x IfcBeam, grouping to 2 clusters at epsilon=3m',
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

      expect(clashResult.summary.total).toBe(50);

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
