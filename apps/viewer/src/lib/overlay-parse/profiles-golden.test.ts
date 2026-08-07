/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GeometryProcessor } from '@ifc-lite/geometry';
import type { ProfileEntry } from '@ifc-lite/drawing-2d';
import { collectFlatProfiles } from './profiles-flat.js';
import { buildProfileEntries } from './profile-entries.js';

/**
 * Byte-equivalence anchor for the construction-projection profile extraction
 * (#2183), the sibling of `symbolic-golden.test.ts`.
 *
 * The extraction moved off the main thread into the overlay worker, which means
 * its output now survives a structured-clone boundary and is reassembled from
 * flat arrays. "Projection still looks right" is not a proof — the failure
 * modes are a hole ring sliced at the wrong offset, an entry handed a
 * neighbour's `ifcType` through a wrapped type index, a transform read off a
 * mis-strided buffer, or the RTC subtraction applied twice or not at all.
 *
 * So: pin a canonical digest of the whole `ProfileEntry[]` against real
 * fixtures. The digests below were captured from the PRE-MOVE code path (the
 * inline `extractProfiles` walk in `useDrawingGeneration`, run verbatim over
 * the same fixtures with the same `SHIFT`), so reproducing them is evidence the
 * move changed nothing. If they drift, the move broke something — fix it,
 * do not regenerate.
 *
 * Fixture choice differs from `symbolic-golden.test.ts` on purpose. Its two
 * models (`01_BIMcollab_Example_ARC`, `ISSUE_102_M3D-CON-CD`) extract exactly
 * ZERO profiles — neither authors `IfcExtrudedAreaSolid` bodies, which is all
 * `extract_profiles` collects — so they would pin the digest of an empty array
 * forever. These two do: 14 entries with holes and mapped items, and 365
 * across ten IFC types.
 *
 * Regenerate with `IFC_GOLDEN_UPDATE=1` and commit the printed digests, but
 * only when the output is *meant* to change — that is the whole point.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

/**
 * Fixture paths CI will actually fetch. Read from the COMMITTED manifest, so
 * a fixture silently dropping out of it fails rather than turning these
 * digests into a permanent skip.
 */
const manifestPaths = new Set<string>(
  (JSON.parse(
    readFileSync(join(REPO_ROOT, 'tests', 'models', 'manifest.json'), 'utf8'),
  ) as { files: { path: string }[] }).files.map((f) => `tests/models/${f.path}`),
);

/**
 * A deliberately non-zero, non-symmetric render-frame shift.
 *
 * The RTC correction is the one piece of arithmetic that stays main-side, so a
 * zero shift would make the digests blind to it being dropped, doubled, or
 * applied to the wrong three slots.
 */
const SHIFT = { x: 1.5, y: -2.25, z: 0.75 };

interface GoldenFixture {
  /** Repo-relative fixture path. */
  path: string;
  /** SHA-256 over {@link canonicalise}. */
  digest: string;
  /** Cheap sanity so a fixture that silently extracts nothing cannot pass. */
  minEntries: number;
}

const FIXTURES: GoldenFixture[] = [
  {
    path: 'tests/models/ara3d/AC20-FZK-Haus.ifc',
    digest: 'fdcc561d74f579dbd8ad59c30efd1005b1d8619113284c55785fa03f742a2011',
    minEntries: 14,
  },
  {
    path: 'tests/models/ara3d/duplex.ifc',
    digest: '508e095171d22ba4152e8f4433dada9775ce26a3f4e421931e6b619d4000c786',
    minEntries: 300,
  },
];

/** Stable, lossless text form of the extracted profiles, in source order. */
function canonicalise(profiles: ProfileEntry[]): string {
  const num = (n: number): string =>
    Number.isNaN(n) ? 'NaN' : Object.is(n, -0) ? '-0' : String(n);
  return JSON.stringify(
    profiles.map((p) => [
      p.expressId,
      p.ifcType,
      Array.from(p.outerPoints).map(num),
      Array.from(p.holeCounts),
      Array.from(p.holePoints).map(num),
      Array.from(p.transform).map(num),
      Array.from(p.extrusionDir).map(num),
      num(p.extrusionDepth),
      p.modelIndex,
    ]),
  );
}

/**
 * The shipping composition, on one thread: WASM walk → flatten → rebuild.
 *
 * `structuredClone` stands in for the `postMessage` hop. It is not decoration:
 * it is what proves the flatten carries nothing that fails to clone and nothing
 * that is a live view into WASM linear memory.
 */
async function extractProfileEntries(source: Uint8Array): Promise<ProfileEntry[]> {
  const processor = new GeometryProcessor();
  try {
    await processor.init();
    const collection = processor.extractProfiles(source, 0);
    if (!collection) return [];
    // `collectFlatProfiles` frees each per-entry handle; the collection itself
    // is the caller's to free, deterministically (AGENTS.md §Geometry & WASM).
    try {
      return buildProfileEntries(structuredClone(collectFlatProfiles(collection)), SHIFT, 0);
    } finally {
      collection.free();
    }
  } finally {
    processor.dispose();
  }
}

describe('profile extraction golden digests (#2183)', () => {
  for (const fixture of FIXTURES) {
    it(`reproduces the pinned ProfileEntry[] for ${fixture.path}`, async (t) => {
      // AGENTS.md requires fixture-backed tests to SKIP, not throw, when the
      // fixture is absent — they are not committed, and CI fetches them via
      // `pnpm fixtures` before running. But a plain skip would also stay
      // silent if the fixture were dropped from the manifest, which WOULD
      // make this permanently vacuous in CI. The manifest is committed, so
      // assert membership there first: absence from the manifest fails,
      // absence from disk skips.
      assert.ok(
        manifestPaths.has(fixture.path),
        `${fixture.path} is not in tests/models/manifest.json, so CI will never fetch it `
        + 'and this digest would silently stop running',
      );
      const abs = join(REPO_ROOT, fixture.path);
      if (!existsSync(abs)) {
        // t.skip() records a SKIP; a bare `return` records a PASS, which is
        // how a fixture-less run silently looks green. It does not stop
        // execution on its own, so the `return` stays.
        t.skip(`${fixture.path} absent — run \`pnpm fixtures\``);
        return;
      }

      const profiles = await extractProfileEntries(new Uint8Array(readFileSync(abs)));

      assert.ok(
        profiles.length >= fixture.minEntries,
        `only ${profiles.length} profiles; a fixture that extracts nothing would make the `
        + 'digest vacuous',
      );

      const digest = createHash('sha256').update(canonicalise(profiles)).digest('hex');
      if (process.env.IFC_GOLDEN_UPDATE === '1') {
        console.log(`${fixture.path}\n  digest: ${digest}\n  entries: ${profiles.length}`);
        return;
      }
      assert.equal(digest, fixture.digest, 'profile extraction output changed');
    });
  }
});
