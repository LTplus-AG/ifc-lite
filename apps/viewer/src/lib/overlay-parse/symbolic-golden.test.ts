/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSymbolicAnnotations } from './symbolic-parse.js';
import type { AnnotationsForStorey, ParseResult } from './symbolic-shapes.js';

/**
 * Byte-equivalence anchor for the symbolic-annotation parse (#2183).
 *
 * The parse is being moved into a worker, which means its output has to
 * survive a structured-clone boundary and be reassembled on the main thread.
 * "The overlay still looks right" is not a proof — the failure modes are a
 * shifted bucket key, a dropped grid/annotation split, a float that lost
 * precision crossing as f32, or a NaN sentinel that turned into null.
 *
 * So: pin a canonical digest of the whole `ParseResult` against real
 * fixtures, before the move. After the move the same digest must reproduce
 * exactly. Fixtures are not committed (see AGENTS.md), so this skips when
 * they are absent rather than failing.
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

interface GoldenFixture {
  /** Repo-relative fixture path. */
  path: string;
  /** SHA-256 over {@link canonicalise}. */
  digest: string;
  /** Cheap sanity so a fixture that silently parses to nothing cannot pass. */
  minPrimitives: number;
}

const FIXTURES: GoldenFixture[] = [
  {
    path: 'tests/models/various/01_BIMcollab_Example_ARC.ifc',
    digest: '838895dd19709818c72698fac680c63ef8de250c237d9997e3d6c9bc077770cc',
    minPrimitives: 80,
  },
  {
    path: 'tests/models/ara3d/ISSUE_102_M3D-CON-CD.ifc',
    digest: '364152e3a148c0b2a303285d31f3ac31866b009a0b7aa2263935631d67046d3e',
    minPrimitives: 400,
  },
];

/** Stable, lossless text form of a ParseResult. Order-independent by construction. */
function canonicalise(result: ParseResult): string {
  const num = (n: number): string =>
    Number.isNaN(n) ? 'NaN' : Object.is(n, -0) ? '-0' : String(n);

  const bucket = (b: AnnotationsForStorey): unknown => ({
    storeyId: b.storeyId,
    storeyElevation: b.storeyElevation === null ? null : num(b.storeyElevation),
    lines: b.lines.map((l) => [
      num(l.line.start.x), num(l.line.start.y),
      num(l.line.end.x), num(l.line.end.y),
      l.category, l.ownerId ?? null,
    ]),
    texts: b.texts.map((t) => [
      num(t.x), num(t.y), num(t.dirX), num(t.dirY), num(t.height),
      t.content, t.alignment, t.ownerId,
      t.lineYOffset === undefined ? null : num(t.lineYOffset),
      t.billboard ?? null,
      t.color ? t.color.map(num) : null,
      t.targetPx === undefined ? null : num(t.targetPx),
    ]),
    fills: b.fills.map((f) => [
      Array.from(f.points).map(num),
      Array.from(f.holesOffsets),
      f.color.map(num),
      f.ownerId,
      f.hatching
        ? [num(f.hatching.spacing), num(f.hatching.angle),
           f.hatching.angleSecondary === null ? null : num(f.hatching.angleSecondary),
           num(f.hatching.lineWidth)]
        : null,
    ]),
  });

  const buckets = (m: Map<number, AnnotationsForStorey>): unknown =>
    [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, bucket(v)]);

  // Reuse the bucket serialiser for the loose arrays by wrapping them.
  const loose = (
    lines: ParseResult['loose'],
    texts: ParseResult['looseTexts'],
    fills: ParseResult['looseFills'],
  ): unknown => bucket({ storeyId: -1, storeyElevation: null, lines, texts, fills });

  return JSON.stringify({
    byStorey: buckets(result.byStorey),
    gridByStorey: buckets(result.gridByStorey),
    loose: loose(result.loose, result.looseTexts, result.looseFills),
    gridLoose: loose(result.gridLoose, result.gridLooseTexts, result.gridLooseFills),
  });
}

function countPrimitives(result: ParseResult): number {
  let n = result.loose.length + result.looseTexts.length + result.looseFills.length
    + result.gridLoose.length + result.gridLooseTexts.length + result.gridLooseFills.length;
  for (const m of [result.byStorey, result.gridByStorey]) {
    for (const b of m.values()) n += b.lines.length + b.texts.length + b.fills.length;
  }
  return n;
}

describe('symbolic parse golden digests (#2183)', () => {
  for (const fixture of FIXTURES) {
    it(`reproduces the pinned ParseResult for ${fixture.path}`, async () => {
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
        console.warn(`skip: ${fixture.path} absent — run \`pnpm fixtures\``);
        return;
      }
      const result = await parseSymbolicAnnotations({ source: new Uint8Array(readFileSync(abs)) });

      const primitives = countPrimitives(result);
      assert.ok(
        primitives >= fixture.minPrimitives,
        `only ${primitives} primitives; a fixture that parses to nothing would make the digest vacuous`,
      );

      const digest = createHash('sha256').update(canonicalise(result)).digest('hex');
      if (process.env.IFC_GOLDEN_UPDATE === '1') {
        console.log(`${fixture.path}\n  digest: ${digest}\n  primitives: ${primitives}`);
        return;
      }
      assert.equal(digest, fixture.digest, 'symbolic parse output changed');
    });
  }
});
