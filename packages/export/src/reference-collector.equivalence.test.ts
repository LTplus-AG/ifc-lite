/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Source-shape equivalence for the export package's widened byte-range readers
 * (#2183): `collectRefsInByteRange`, `collectReferencedEntityIds` and
 * `collectStyleEntities`.
 *
 * These three are the byte-SCANNING readers: they never decode a string, they
 * ask `IfcSourceBytes.slice` for one record's bytes and walk it looking for
 * `#` + digits. That makes them the highest-risk part of the widening (a
 * blocked/compressed source has to reconstruct that span, not just a string)
 * and the least protected by `entity-extractor.equivalence.test.ts`, which
 * only covers the `decodeUtf8` side of the interface.
 *
 * THREE sides, deliberately. `reader(raw)` vs `reader(asSourceBytes(raw))`
 * ALONE IS A TAUTOLOGY: all three readers normalise through `asSourceBytes`,
 * which wraps a `Uint8Array` in the same `ContiguousSourceBytes`, so both sides
 * run one implementation and a bad `slice` shifts them equally.
 *
 *   raw        the `Uint8Array` every call site passes today
 *   accessor   `asSourceBytes(raw)` — the shape the migration moves to.
 *              (`contiguousSourceBytes` itself is parser-internal; on a
 *              `Uint8Array` `asSourceBytes` IS `contiguousSourceBytes`.)
 *   reference  an independent, deliberately naive `IfcSourceBytes` that copies
 *              the requested range byte by byte and shares no code with the
 *              implementation under test
 *
 * Every case additionally pins a CONCRETE expected id set, because "all three
 * sides agree" is satisfied by three empty sets.
 *
 * Range fidelity is pinned where these readers are actually SENSITIVE to it.
 * A STEP record is padded at both ends by tokens the walk ignores — the leading
 * `#42=` (whose id is the record's own, hence already visited) and the trailing
 * `);` — so a CLOSURE is structurally blind to a one-byte truncation at either
 * end. `collectRefsInByteRange` is not: it returns the record's own id too, and
 * it takes an ARBITRARY range from its caller (the demesher's reverse-reference
 * prune), so the sub-range case below puts a reference digit on both the first
 * and the last byte of the requested span.
 *
 * Mutation-checked, measured not assumed:
 *
 *   decodeUtf8 start+1   green, and CORRECTLY so: none of these three readers
 *                        ever decodes. That mutation is covered by
 *                        `entity-extractor.equivalence.test.ts` and by the
 *                        parser's own `widened-readers.equivalence.test.ts`.
 *   slice start+1        RED (3/7) — both `collectRefsInByteRange` cases plus
 *                        the fixture sweep. The two closure cases stay green
 *                        for the structural reason above; no correct assertion
 *                        on a closure can fail on that mutation.
 *   slice wrong origin   RED (5/7) — every record reads from byte 0, the bug
 *   (`subarray(0,e-s)`)  class a blocked/compressed source introduces. This is
 *                        what proves the closure cases are not hollow.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asSourceBytes, scanIfcEntities, type IfcSourceBytes } from '@ifc-lite/parser';
import {
  collectReferencedEntityIds,
  collectRefsInByteRange,
  collectStyleEntities,
} from './reference-collector.js';

/** Fixture, relative to `tests/models`. Fixtures are NOT committed (AGENTS.md). */
const FIXTURE_RELPATH = 'ara3d/AC20-FZK-Haus.ifc';

/** Non-vacuity floor: AC20-FZK-Haus indexes ~44k records. */
const MIN_ENTITIES = 10_000;

// `import.meta.url`, not `cwd`: the test must resolve the same fixture whether
// it runs from the repo root (turbo) or from the package directory.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MANIFEST_PATH = resolve(REPO_ROOT, 'tests', 'models', 'manifest.json');
const FIXTURE_PATH = resolve(REPO_ROOT, 'tests', 'models', FIXTURE_RELPATH);

interface FixtureManifest {
  files?: { path?: string }[];
}

/** Structured-clone shape of a source; mirrors the parser's `IfcSourceTransfer`
 *  contiguous arm, which is all the reference implementation ever produces. */
type ReferenceTransfer = ReturnType<IfcSourceBytes['toTransferable']>;

/**
 * An independent `IfcSourceBytes` written from the interface contract alone —
 * no `subarray` views, nothing shared with `ContiguousSourceBytes`. Every read
 * copies the requested range byte by byte. Slow on purpose: its job is to
 * disagree when the real implementation reads the wrong bytes.
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
    toTransferable: (): ReferenceTransfer => ({
      kind: 'contiguous',
      bytes: copy(0, len),
      contentKey: `reference-${len}`,
    }),
  };
}

interface IndexEntry { type: string; byteOffset: number; byteLength: number }

interface Model {
  text: string;
  raw: Uint8Array;
  byId: Map<number, IndexEntry>;
  byType: Map<string, number[]>;
}

/** Build a source buffer + entity index from one-record-per-line STEP text. */
function inlineModel(lines: string[]): Model {
  const encoder = new TextEncoder();
  const byId = new Map<number, IndexEntry>();
  const byType = new Map<string, number[]>();
  let offset = 0;
  for (const line of lines) {
    const match = line.match(/^#(\d+)\s*=\s*(\w+)/);
    if (!match) throw new Error(`inlineModel: unparseable record: ${line}`);
    const expressId = Number(match[1]);
    const type = match[2].toUpperCase();
    const encoded = encoder.encode(line);
    byId.set(expressId, { type, byteOffset: offset, byteLength: encoded.byteLength });
    const ids = byType.get(type);
    if (ids) ids.push(expressId);
    else byType.set(type, [expressId]);
    // Newline separator, so a reader that over-reads by a byte picks up
    // something that is NOT part of the record.
    offset += encoded.byteLength + 1;
  }
  const text = lines.map((l) => `${l}\n`).join('');
  return { text, raw: encoder.encode(text), byId, byType };
}

/**
 * A wall with a full geometry chain, a style chain hanging off that geometry,
 * and two decoys:
 *   - `#30`'s Name contains the TEXT `#23`, which must NOT become an edge
 *     (`#23` is a real entity in this index, so a broken string-literal skip
 *     shows up as an extra member of the pinned closure).
 *   - `#31` is a styled item whose geometry `#41` is outside the closure, so
 *     the reverse style pass must leave it, `#41` and `#42` out.
 */
const MODEL = [
  "#1=IFCWALL('guid-1',#2,'Wall-A',$,$,#3,#4,$);",
  '#2=IFCOWNERHISTORY(#5,$,$,$);',
  '#3=IFCLOCALPLACEMENT($,#6);',
  '#4=IFCPRODUCTDEFINITIONSHAPE($,$,(#7));',
  '#5=IFCPERSONANDORGANIZATION(#8,#9,$);',
  '#6=IFCAXIS2PLACEMENT3D(#10,$,$);',
  "#7=IFCSHAPEREPRESENTATION(#11,'Body','Brep',(#12));",
  "#8=IFCPERSON($,'Author',$,$,$,$,$,$);",
  "#9=IFCORGANIZATION($,'Org',$,$,$);",
  '#10=IFCCARTESIANPOINT((0.,0.,0.));',
  "#11=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#10,$);",
  '#12=IFCEXTRUDEDAREASOLID(#13,#6,#14,2.5);',
  '#13=IFCRECTANGLEPROFILEDEF(.AREA.,$,#15,0.2,5.0);',
  '#14=IFCDIRECTION((0.,0.,1.));',
  '#15=IFCAXIS2PLACEMENT2D(#10,$);',
  '#20=IFCSTYLEDITEM(#12,(#21),$);',
  '#21=IFCPRESENTATIONSTYLEASSIGNMENT((#22));',
  "#22=IFCSURFACESTYLE('Paint',.BOTH.,(#23));",
  '#23=IFCSURFACESTYLERENDERING(#24,0.,$,$,$,$,$,$,.NOTDEFINED.);',
  '#24=IFCCOLOURRGB($,0.8,0.8,0.8);',
  "#30=IFCWALL('guid-2','see #23 for the finish',$,$,$,$,$,$);",
  '#31=IFCSTYLEDITEM(#41,(#42),$);',
  '#41=IFCEXTRUDEDAREASOLID(#13,#6,#14,1.0);',
  '#42=IFCPRESENTATIONSTYLEASSIGNMENT((#22));',
];

/** Closure from roots {1, 30}: the wall's owner-history, placement and
 *  geometry chains. `#23` must be absent — it is only ever MENTIONED, inside a
 *  STEP string literal on `#30`. */
const EXPECTED_CLOSURE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 30];

/** After the reverse style pass: `#20` reaches geometry `#12`, and its style
 *  chain follows. `#31`/`#41`/`#42` stay out — nothing they touch is in the
 *  closure. */
const EXPECTED_AFTER_STYLES = [...EXPECTED_CLOSURE, 20, 21, 22, 23, 24].sort((a, b) => a - b);

function sorted(ids: Iterable<number>): number[] {
  return [...ids].sort((a, b) => a - b);
}

/** The three source shapes under test, in comparison order. */
function shapes(raw: Uint8Array): Array<[string, Uint8Array | IfcSourceBytes]> {
  return [
    ['raw', raw],
    ['accessor', asSourceBytes(raw)],
    ['reference', referenceSourceBytes(raw)],
  ];
}

describe('reference-collector: source-shape equivalence', () => {
  it('lists the fixture in the committed manifest so CI actually fetches it', () => {
    // Asserted SEPARATELY, and before any skip, so the fixture-backed case
    // below cannot silently skip forever: `pnpm fixtures` only fetches what the
    // manifest catalogues, so a dropped entry would make the file permanently
    // absent on CI and the skip permanently green.
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as FixtureManifest;
    const paths = (manifest.files ?? []).map((f) => f.path);
    expect(paths).toContain(FIXTURE_RELPATH);
  });

  describe('collectRefsInByteRange', () => {
    it('returns the same edges from a Uint8Array, an IfcSourceBytes and a reference source', () => {
      const { raw, byId } = inlineModel(MODEL);
      const record = byId.get(1)!;

      const results = shapes(raw).map(([name, source]) => [
        name,
        collectRefsInByteRange(source, record.byteOffset, record.byteLength),
      ] as const);

      // Pinned, and the record's OWN id is part of the contract: `#1` is the
      // first byte of the requested range, so a range that starts one byte late
      // loses it. Three empty arrays would otherwise compare equal.
      for (const [name, refs] of results) {
        expect(refs, name).toEqual([1, 2, 3, 4]);
      }
    });

    it('honours an arbitrary sub-range on both edges', () => {
      const { text, raw } = inlineModel(MODEL);
      // A span whose FIRST byte is the `#` of `#3` and whose LAST byte is the
      // `4` of `#4`, inside record #1. Reading one byte late drops the `3`
      // reference; stopping one byte early drops the `4`. This is the shape of
      // range the demesher's reverse-reference prune asks for.
      const start = text.indexOf('#3,#4');
      const end = start + '#3,#4'.length;
      expect(start).toBeGreaterThan(0);

      for (const [name, source] of shapes(raw)) {
        expect(collectRefsInByteRange(source, start, end - start), name).toEqual([3, 4]);
      }
      // Control: the same span one byte short at each edge really does change
      // the answer, so the assertion above is load-bearing.
      expect(collectRefsInByteRange(raw, start + 1, end - start - 1)).toEqual([4]);
      expect(collectRefsInByteRange(raw, start, end - start - 1)).toEqual([3]);
    });
  });

  describe('collectReferencedEntityIds', () => {
    it('walks the same closure from a Uint8Array, an IfcSourceBytes and a reference source', () => {
      const { raw, byId } = inlineModel(MODEL);
      const index = {
        get: (id: number) => byId.get(id),
        has: (id: number) => byId.has(id),
      };

      for (const [name, source] of shapes(raw)) {
        const closure = collectReferencedEntityIds(new Set([1, 30]), source, index);
        // Pinned: an empty or truncated closure is this reader's failure mode,
        // and three identical failures compare equal.
        expect(sorted(closure), name).toEqual(EXPECTED_CLOSURE);
      }
    });

    it('applies excludeIds identically across source shapes', () => {
      const { raw, byId } = inlineModel(MODEL);
      const index = {
        get: (id: number) => byId.get(id),
        has: (id: number) => byId.has(id),
      };

      for (const [name, source] of shapes(raw)) {
        const closure = collectReferencedEntityIds(new Set([1, 30]), source, index, new Set([4]));
        // Blocking the shape reference prunes the whole geometry sub-tree that
        // is reachable only through it: 4, 7, 11, 12, 13, 14, 15.
        expect(sorted(closure), name).toEqual([1, 2, 3, 5, 6, 8, 9, 10, 30]);
      }
    });
  });

  describe('collectStyleEntities', () => {
    it('adds the same style chain from a Uint8Array, an IfcSourceBytes and a reference source', () => {
      const { raw, byId, byType } = inlineModel(MODEL);
      const entityIndex = {
        byId: {
          get: (id: number) => byId.get(id),
          has: (id: number) => byId.has(id),
        },
        byType,
      };

      for (const [name, source] of shapes(raw)) {
        const closure = new Set(EXPECTED_CLOSURE);
        collectStyleEntities(closure, source, entityIndex);
        expect(sorted(closure), name).toEqual(EXPECTED_AFTER_STYLES);
      }
    });
  });

  it('agrees across source shapes on a real IFC file', async (ctx) => {
    if (!existsSync(FIXTURE_PATH)) {
      // ctx.skip(), never a bare `return`: a return records a PASS, so the
      // suite would look green on a machine that has no fixtures at all.
      ctx.skip(`${FIXTURE_RELPATH} missing — run \`pnpm fixtures\` to fetch it`);
    }

    const file = readFileSync(FIXTURE_PATH);
    // Copy into a clean ArrayBuffer: a Node Buffer aliases a shared pool, so
    // `file.buffer` is not the file's bytes.
    const ab = new ArrayBuffer(file.byteLength);
    const raw = new Uint8Array(ab);
    raw.set(file);

    // Pure-TS tokenizer path (no worker, no wasm): the index is built without
    // touching the readers compared below.
    const { entityRefs } = await scanIfcEntities(ab, { disableWorkerScan: true });
    const byId = new Map<number, IndexEntry>();
    const byType = new Map<string, number[]>();
    for (const ref of entityRefs) {
      byId.set(ref.expressId, { type: ref.type, byteOffset: ref.byteOffset, byteLength: ref.byteLength });
      const ids = byType.get(ref.type);
      if (ids) ids.push(ref.expressId);
      else byType.set(ref.type, [ref.expressId]);
    }
    expect(byId.size).toBeGreaterThanOrEqual(MIN_ENTITIES);

    const index = {
      get: (id: number) => byId.get(id),
      has: (id: number) => byId.has(id),
    };
    const entityIndex = { byId: { get: index.get, has: index.has }, byType };

    // --- collectRefsInByteRange, over EVERY record -------------------------
    // Not a sample: this is the per-entity edge set the demesher prunes on.
    const rawSrc = raw;
    const accessorSrc = asSourceBytes(raw);
    const referenceSrc = referenceSourceBytes(raw);
    let edges = 0;
    const shapeMismatches: string[] = [];
    const oracleMismatches: string[] = [];
    for (const [id, entry] of byId) {
      const a = collectRefsInByteRange(rawSrc, entry.byteOffset, entry.byteLength);
      const b = collectRefsInByteRange(accessorSrc, entry.byteOffset, entry.byteLength);
      const c = collectRefsInByteRange(referenceSrc, entry.byteOffset, entry.byteLength);
      edges += a.length;
      // Every record starts with its own `#id`, so a correct read always
      // reports at least that one edge. An empty array means the range was
      // read wrong.
      if (a[0] !== id && shapeMismatches.length < 5) {
        shapeMismatches.push(`#${id}: first edge ${a[0]} !== own id`);
      }
      const ja = JSON.stringify(a);
      if (ja !== JSON.stringify(b) && shapeMismatches.length < 5) {
        shapeMismatches.push(`#${id}: raw=${ja} accessor=${JSON.stringify(b)}`);
      }
      if (ja !== JSON.stringify(c) && oracleMismatches.length < 5) {
        oracleMismatches.push(`#${id}: raw=${ja} reference=${JSON.stringify(c)}`);
      }
    }
    expect(shapeMismatches).toEqual([]);
    expect(oracleMismatches).toEqual([]);
    expect(edges).toBeGreaterThanOrEqual(byId.size);

    // --- collectReferencedEntityIds ---------------------------------------
    const roots = new Set<number>();
    for (const type of ['IFCWALLSTANDARDCASE', 'IFCWALL', 'IFCSLAB', 'IFCWINDOW', 'IFCDOOR']) {
      for (const id of byType.get(type) ?? []) roots.add(id);
    }
    expect(roots.size).toBeGreaterThan(0);

    const closureRaw = collectReferencedEntityIds(roots, rawSrc, index);
    const closureAccessor = collectReferencedEntityIds(roots, accessorSrc, index);
    const closureReference = collectReferencedEntityIds(roots, referenceSrc, index);
    // A closure that walked nothing would be exactly `roots` on all three
    // sides and still compare equal, so require real transitive growth.
    expect(closureRaw.size).toBeGreaterThan(roots.size * 5);
    expect(sorted(closureAccessor)).toEqual(sorted(closureRaw));
    expect(sorted(closureReference)).toEqual(sorted(closureRaw));

    // --- collectStyleEntities ---------------------------------------------
    const styledRaw = new Set(closureRaw);
    const styledAccessor = new Set(closureRaw);
    const styledReference = new Set(closureRaw);
    collectStyleEntities(styledRaw, rawSrc, entityIndex);
    collectStyleEntities(styledAccessor, accessorSrc, entityIndex);
    collectStyleEntities(styledReference, referenceSrc, entityIndex);
    // The reverse pass must actually find styled items on this fixture (it has
    // ~393 IFCSTYLEDITEM records); otherwise the comparison below is over a
    // no-op.
    expect(styledRaw.size).toBeGreaterThan(closureRaw.size);
    expect(sorted(styledAccessor)).toEqual(sorted(styledRaw));
    expect(sorted(styledReference)).toEqual(sorted(styledRaw));
  });
});
