/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * All-entity equivalence across source shapes (#2183).
 *
 * `EntityExtractor` accepts either a raw `Uint8Array` or an `IfcSourceBytes`.
 * The on-demand readers across property, quantity, material, classification,
 * attribute and spatial extraction funnel their byte reads through this one
 * class — 42 non-test construction sites at the time of writing — so proving
 * the shapes are indistinguishable HERE covers all of them at once. This is a
 * seam test, not an extractor test, and it asserts on EVERY indexed entity,
 * never a sample.
 *
 * THREE sides, not two, and the third is what gives the suite teeth:
 *
 *   raw       `new EntityExtractor(uint8Array)`
 *   accessor  `new EntityExtractor(contiguousSourceBytes(uint8Array))`
 *   reference `new EntityExtractor(referenceSourceBytes(uint8Array))`
 *
 * `raw` vs `accessor` alone CANNOT FAIL: the extractor constructor normalises
 * a `Uint8Array` through `asSourceBytes`, which wraps it in the very same
 * `ContiguousSourceBytes`, so the two sides are the same implementation and an
 * off-by-one in `decodeUtf8` shifts both identically. Verified, not assumed —
 * with `decodeUtf8` mutated to `e - 1` that two-way comparison stayed green.
 *
 * `reference` is an independent, deliberately naive `IfcSourceBytes` (copy the
 * range, hand it to `TextDecoder`) that shares no code with the implementation
 * under test. It is the oracle: it is what makes a real decode bug in
 * `ContiguousSourceBytes` show up as a diff rather than as a shifted-but-equal
 * pair.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EntityExtractor } from './entity-extractor.js';
import { contiguousSourceBytes, type IfcSourceBytes, type IfcSourceTransfer } from './source-bytes.js';
import { scanIfcEntities } from './entity-scanner.js';
import type { EntityRef } from './types.js';

/** Fixture, relative to `tests/models`. Fixtures are NOT committed (AGENTS.md). */
const FIXTURE_RELPATH = 'ara3d/AC20-FZK-Haus.ifc';

/**
 * Non-vacuity floor. AC20-FZK-Haus indexes ~44k records; a fixture that parsed
 * to a handful of entities (or to none) must fail rather than pass a
 * comparison over an empty loop.
 */
const MIN_ENTITIES = 10_000;

// `import.meta.url`, not `cwd`: the test must resolve the same fixture whether
// it is run from the repo root (turbo) or from the package directory.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MANIFEST_PATH = resolve(REPO_ROOT, 'tests', 'models', 'manifest.json');
const FIXTURE_PATH = resolve(REPO_ROOT, 'tests', 'models', FIXTURE_RELPATH);

interface FixtureManifest {
  files?: { path?: string }[];
}

/**
 * An independent `IfcSourceBytes` written from the interface contract alone —
 * no `subarray` views, no `safeUtf8Decode`, nothing shared with
 * `ContiguousSourceBytes`. Every read copies the requested range and decodes
 * it with a plain `TextDecoder`. Slow and allocation-happy on purpose: its job
 * is to disagree when the real implementation reads the wrong bytes.
 */
function referenceSourceBytes(bytes: Uint8Array): IfcSourceBytes {
  const decoder = new TextDecoder();
  const len = bytes.byteLength;
  const clamp = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(Math.trunc(n), len)) : 0);
  const copy = (start: number, end: number): Uint8Array => {
    const s = clamp(start);
    const e = Math.max(s, clamp(end));
    const out = new Uint8Array(e - s);
    for (let i = s; i < e; i++) out[i - s] = bytes[i];
    return out;
  };
  return {
    byteLength: len,
    length: len,
    isResident: true,
    contentKey: `reference-${len}`,
    slice: (start: number, end: number) => copy(start, end),
    decodeUtf8: (start: number, end: number) => decoder.decode(copy(start, end)),
    materialize: () => copy(0, len),
    withMaterialized: <T,>(fn: (b: Uint8Array) => T) => fn(copy(0, len)),
    withMaterializedAsync: <T,>(fn: (b: Uint8Array) => Promise<T>) => fn(copy(0, len)),
    toTransferable: (): IfcSourceTransfer => ({
      kind: 'contiguous',
      bytes: copy(0, len),
      contentKey: `reference-${len}`,
    }),
  };
}

describe('EntityExtractor source-shape equivalence', () => {
  it('lists the fixture in the committed manifest so CI actually fetches it', () => {
    // Asserted SEPARATELY, and before the skip, so the equivalence test below
    // cannot silently skip forever if the fixture is ever dropped from the
    // manifest: `pnpm fixtures` only fetches what the manifest catalogues, so a
    // dropped entry would make the file permanently absent on CI and the skip
    // permanently green.
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as FixtureManifest;
    const paths = (manifest.files ?? []).map((f) => f.path);
    expect(paths).toContain(FIXTURE_RELPATH);
  });

  // 60s, not vitest's default 5s: this sweeps EVERY record in a ~44k-entity
  // fixture through three extractors and six `JSON.stringify` calls per record
  // (~130k stringifies). That is deliberate — the whole point is an exhaustive
  // equivalence oracle, not a sample — but it means the default budget was
  // never a considered one, and on a loaded CI runner the test lost to it and
  // reddened unrelated PRs (#2320, #2349, #2360). It runs in ~180ms locally,
  // so this ceiling is ~300x headroom: it will still fail loudly if the work
  // becomes genuinely pathological, rather than flaking at the margin.
  it('extracts identical entities from a Uint8Array, an IfcSourceBytes, and a reference source', async (ctx) => {
    if (!existsSync(FIXTURE_PATH)) {
      // ctx.skip(), never a bare `return`: a return records a PASS, so on a
      // machine (or a CI lane) without fixtures this harness would report green
      // while asserting nothing.
      ctx.skip(`${FIXTURE_RELPATH} missing — run \`pnpm fixtures\` to fetch it`);
    }

    const file = readFileSync(FIXTURE_PATH);
    // Copy into a clean ArrayBuffer: a Node Buffer aliases a shared pool, so
    // `file.buffer` is not the file's bytes.
    const ab = new ArrayBuffer(file.byteLength);
    const raw = new Uint8Array(ab);
    raw.set(file);

    // disableWorkerScan keeps the scan in-process (there is no Worker in the
    // Node test env anyway) and no wasmApi is passed, so this is the pure-TS
    // tokenizer path: the index is produced without touching the code compared
    // below.
    const { entityRefs } = await scanIfcEntities(ab, { disableWorkerScan: true });

    const byId = new Map<number, EntityRef>();
    for (const ref of entityRefs) byId.set(ref.expressId, ref);

    expect(byId.size).toBeGreaterThanOrEqual(MIN_ENTITIES);

    const fromRaw = new EntityExtractor(raw);
    const fromAccessor = new EntityExtractor(contiguousSourceBytes(raw));
    const fromReference = new EntityExtractor(referenceSourceBytes(raw));

    let compared = 0;
    let extracted = 0;
    let attributeValues = 0;
    const shapeMismatches: string[] = [];
    const oracleMismatches: string[] = [];

    for (const ref of byId.values()) {
      const rawEntity = fromRaw.extractEntity(ref);
      const a = JSON.stringify(rawEntity);
      const b = JSON.stringify(fromAccessor.extractEntity(ref));
      const c = JSON.stringify(fromReference.extractEntity(ref));
      compared++;
      if (rawEntity) {
        extracted++;
        attributeValues += rawEntity.attributes.length;
      }
      if (a !== b && shapeMismatches.length < 5) {
        shapeMismatches.push(`#${ref.expressId} (${ref.type}):\n  raw=${a}\n  accessor=${b}`);
      }
      if (a !== c && oracleMismatches.length < 5) {
        oracleMismatches.push(`#${ref.expressId} (${ref.type}):\n  raw=${a}\n  reference=${c}`);
      }
    }

    // The union contract: passing either shape to the constructor is the same.
    expect(shapeMismatches).toEqual([]);
    // The oracle: what the accessor decodes is what is actually in the file.
    expect(oracleMismatches).toEqual([]);
    expect(compared).toBe(byId.size);
    // The comparisons are only meaningful over records that actually extracted.
    // `JSON.stringify(null)` is the STRING `"null"`, so a run where every
    // extraction failed would still compare equal on every side and prove
    // nothing — count real entities, and real attribute values inside them.
    expect(extracted).toBeGreaterThanOrEqual(MIN_ENTITIES);
    expect(attributeValues).toBeGreaterThanOrEqual(MIN_ENTITIES);
  }, 60_000);
});
