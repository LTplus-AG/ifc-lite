/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DXF writer conformance: read back by something that is NOT ours, and pinned
 * against the DXF R12 group codes the specification names.
 *
 * `writer.test.ts` round-trips every entity kind through `parser.ts` — this
 * package's own DXF reader. A writer and a reader that agree with each other
 * prove they share a convention, not that the convention is DXF: our parser is
 * deliberately lenient (it is built to survive files other tools wrote), so it
 * happily accepts output a strict CAD reader would reject or repair. There is
 * no `.dxf` file anywhere in this repository, so nothing else could disagree.
 *
 * Two independent checks close that:
 *
 * 1. `dxf-parser` (npm, MIT) — an unrelated third-party DXF reader, added as a
 *    dev dependency. It is not a validator (no DXF validator exists as a
 *    library), but it IS a foreign implementation: it has its own idea of what
 *    the group codes mean, so agreement with it is evidence about the format
 *    rather than about us.
 * 2. Assertions on the raw (code, value) pair stream against the R12 rules
 *    themselves — the parts a lenient reader will not miss because it does not
 *    need them (POLYLINE's `66` vertices-follow flag, the TEXT alignment point
 *    `11/21/31` that must accompany a non-zero `72`/`73`, section balance).
 *
 * A third-party DXF *fixture* would be the other half — proving we can READ
 * what other tools write. None is committed here: model fixtures in this repo
 * are fetched from the manifest bucket rather than committed
 * (AGENTS.md §Test fixtures), and this suite has no fetch step.
 */

import { describe, expect, it } from 'vitest';
import DxfParserModule from 'dxf-parser';
import type {
  DxfParser as DxfParserInstance,
  ILineEntity,
  IPolylineEntity,
  ITextEntity,
} from 'dxf-parser';
import { DxfWriter } from './writer.js';
import { cssToAci } from './aci-colors.js';

/**
 * `dxf-parser` ships two builds: an ESM one whose `.d.ts` TypeScript resolves
 * (named + default export) and a CJS bundle whose `module.exports` IS the class,
 * which is what vitest loads. The repo compiles without `esModuleInterop`, so
 * the default import is typed as a namespace rather than the constructor.
 * Bridge the two once, here, instead of at every call site.
 */
const DxfParser = DxfParserModule as unknown as new () => DxfParserInstance;

/** One document exercising every entity kind the writer emits. */
function buildDocument(): string {
  const w = new DxfWriter({ headerComment: 'ifc-lite export - units: metres' });
  const walls = w.layer('Wände', '#ff0000');
  const anno = w.layer('anno', '#000000', 'DASHED');
  w.addLine({ x: 1.5, y: -2.25 }, { x: 10, y: 20 }, walls);
  w.addPolyline([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }], walls, true);
  w.addPolyline([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 }], anno, false);
  w.addText({ x: 3, y: 4 }, 'Room 101', 0.25, anno, {
    rotationDeg: 90,
    hAlign: 'center',
    vAlign: 'middle',
  });
  w.addText({ x: 0, y: 0 }, 'plain', 0.2, anno, { colorOverride: '#00ff00' });
  return w.toString();
}

/** The file as the (group code, value) pairs DXF is defined in terms of. */
function pairs(dxf: string): Array<[string, string]> {
  const lines = dxf.split('\n');
  // A DXF file is an even number of lines: code, value, code, value…
  // (`toString` ends with a trailing newline, hence the pop.)
  if (lines[lines.length - 1] === '') lines.pop();
  expect(lines.length % 2, 'DXF is a stream of code/value PAIRS').toBe(0);
  const out: Array<[string, string]> = [];
  for (let i = 0; i < lines.length; i += 2) {
    expect(lines[i], `line ${i} must be a group code`).toMatch(/^-?\d+$/);
    out.push([lines[i].trim(), lines[i + 1]]);
  }
  return out;
}

describe('DXF writer read back by an independent reader (dxf-parser, MIT)', () => {
  const dxf = buildDocument();
  const doc = new DxfParser().parseSync(dxf);

  it('parses at all — a foreign reader accepts the file', () => {
    expect(doc).toBeTruthy();
    expect(doc?.entities ?? []).toHaveLength(5);
  });

  it('declares R12 and the extents a foreign reader will frame the drawing by', () => {
    expect(doc?.header?.['$ACADVER']).toBe('AC1009');
    // Extents come from the finite geometry: x spans 0..10, y spans -2.25..20.
    expect(doc?.header?.['$EXTMIN']).toMatchObject({ x: 0, y: -2.25 });
    expect(doc?.header?.['$EXTMAX']).toMatchObject({ x: 10, y: 20 });
  });

  it('carries both layers, sanitized, with their linetypes and colours', () => {
    const layers = doc?.tables?.layer?.layers ?? {};
    // 'Wände' sanitizes to the R12 symbol-name charset.
    expect(layers['W_nde']).toBeTruthy();
    expect(layers['W_nde'].color).toBe(0xff0000);
    expect(layers['anno']).toBeTruthy();
    const ltypes = doc?.tables?.lineType?.lineTypes ?? {};
    expect(Object.keys(ltypes).sort()).toEqual(['CONTINUOUS', 'DASHED']);
  });

  it('reads the LINE at the coordinates it was given', () => {
    const line = doc?.entities.find((e) => e.type === 'LINE') as ILineEntity | undefined;
    expect(line?.layer).toBe('W_nde');
    expect(line?.vertices[0]).toMatchObject({ x: 1.5, y: -2.25 });
    expect(line?.vertices[1]).toMatchObject({ x: 10, y: 20 });
  });

  it('reads the closed and open POLYLINEs with the right vertex counts and closed flag', () => {
    const polys = (doc?.entities ?? []).filter(
      (e): e is IPolylineEntity => e.type === 'POLYLINE',
    );
    expect(polys).toHaveLength(2);
    // `shape` is dxf-parser's name for group 70 bit 1 (closed).
    expect(polys[0].shape).toBe(true);
    expect(polys[0].vertices).toHaveLength(4);
    expect(polys[0].vertices[2]).toMatchObject({ x: 5, y: 5 });
    expect(polys[1].shape).toBe(false);
    expect(polys[1].vertices).toHaveLength(3);
  });

  it('reads TEXT height, rotation, justification and the per-entity colour override', () => {
    const texts = (doc?.entities ?? []).filter((e): e is ITextEntity => e.type === 'TEXT');
    expect(texts).toHaveLength(2);
    expect(texts[0].text).toBe('Room 101');
    expect(texts[0].textHeight).toBe(0.25);
    expect(texts[0].rotation).toBe(90);
    expect(texts[0].halign).toBe(1); // group 72, centre
    expect(texts[0].valign).toBe(2); // group 73, middle
    expect(texts[0].startPoint).toMatchObject({ x: 3, y: 4 });
    expect(texts[1].text).toBe('plain');
    expect(texts[1].colorIndex).toBe(cssToAci('#00ff00'));
  });
});

describe('DXF writer against the R12 group codes themselves (no parser involved)', () => {
  const dxf = buildDocument();
  const p = pairs(dxf);

  it('opens with a 999 comment and closes with the mandatory 0/EOF', () => {
    expect(p[0]).toEqual(['999', 'ifc-lite export - units: metres']);
    expect(p[p.length - 1]).toEqual(['0', 'EOF']);
  });

  it('balances every SECTION with an ENDSEC and every TABLE with an ENDTAB', () => {
    const count = (code: string, value: string) =>
      p.filter(([c, v]) => c === code && v === value).length;
    expect(count('0', 'SECTION')).toBe(3); // HEADER, TABLES, ENTITIES
    expect(count('0', 'ENDSEC')).toBe(3);
    expect(count('0', 'TABLE')).toBe(3); // LTYPE, STYLE, LAYER
    expect(count('0', 'ENDTAB')).toBe(3);
  });

  it('gives POLYLINE the 66 "vertices follow" flag the R12 entity requires', () => {
    // A lenient reader infers the VERTEX chain from what follows and never
    // needs 66; a strict one treats its absence as "no vertices" and drops the
    // whole polyline. Nothing but this asserts it.
    const polyStarts = p.flatMap(([c, v], i) => (c === '0' && v === 'POLYLINE' ? [i] : []));
    expect(polyStarts).toHaveLength(2);
    for (const i of polyStarts) {
      const body = p.slice(i + 1, i + 12);
      expect(body.find(([c]) => c === '66')?.[1], 'POLYLINE needs 66/1').toBe('1');
      // The 10/20/30 "dummy point" is part of the R12 POLYLINE entity; the
      // real coordinates live on the VERTEX chain.
      expect(body.find(([c]) => c === '10')?.[1]).toBe('0.0');
      expect(body.find(([c]) => c === '70')).toBeTruthy();
    }
  });

  it('closes every VERTEX chain with SEQEND, and every entity names its layer', () => {
    const entityStarts = p.flatMap(([c, v], i) =>
      c === '0' && ['LINE', 'POLYLINE', 'VERTEX', 'SEQEND', 'TEXT'].includes(v) ? [i] : [],
    );
    for (const i of entityStarts) {
      // Group 8 (layer) is mandatory on every entity; a missing one silently
      // reassigns the entity to layer "0" in a real reader.
      const eight = p.slice(i + 1, i + 3).find(([c]) => c === '8');
      expect(eight, `entity ${p[i][1]} at pair ${i} must carry group 8`).toBeTruthy();
      expect(eight?.[1]).not.toBe('');
    }
    const kinds = entityStarts.map((i) => p[i][1]);
    expect(kinds.filter((k) => k === 'SEQEND')).toHaveLength(
      kinds.filter((k) => k === 'POLYLINE').length,
    );
  });

  it('emits the TEXT alignment point 11/21/31 exactly when 72/73 are non-zero', () => {
    // R12 TEXT: groups 72/73 select a justification, but the point the text is
    // justified ABOUT is 11/21/31 — 10/20/30 stays the (unused) first
    // alignment point. Set 72/73 without 11/21 and a conforming reader draws
    // the string at the origin. Set 11/21 with 72=73=0 and it is ignored.
    const starts = p.flatMap(([c, v], i) => (c === '0' && v === 'TEXT' ? [i] : []));
    expect(starts).toHaveLength(2);
    for (const i of starts) {
      const end = p.findIndex(([c], j) => j > i && c === '0');
      const body = p.slice(i + 1, end === -1 ? undefined : end);
      const g = (code: string) => body.find(([c]) => c === code)?.[1];
      expect(g('1'), 'TEXT needs its string in group 1').toBeTruthy();
      expect(g('40'), 'TEXT needs a height in group 40').toBeTruthy();
      const justified = g('72') !== '0' || g('73') !== '0';
      if (justified) {
        expect(g('11'), 'justified TEXT needs alignment point 11').toBeTruthy();
        expect(g('21'), 'justified TEXT needs alignment point 21').toBeTruthy();
        expect(g('31')).toBe('0.0');
        // …and it must be the SAME point as 10/20, not a stale or zeroed one.
        expect(g('11')).toBe(g('10'));
        expect(g('21')).toBe(g('20'));
      } else {
        expect(g('11'), 'unjustified TEXT must not carry an alignment point').toBeUndefined();
      }
    }
  });

  it('uses no group code that only exists from R13 on', () => {
    // 100 (subclass marker), 330 (owner), 370 (lineweight), 410 (layout) and
    // 420 (true colour) are all post-R12; emitting one while declaring AC1009
    // makes a hybrid file that strict readers repair or reject.
    for (const forbidden of ['100', '330', '370', '410', '420']) {
      expect(p.some(([c]) => c === forbidden), `group ${forbidden} is post-R12`).toBe(false);
    }
  });

  it('emits no entity handles, so no $HANDLING/$HANDSEED contract is implied', () => {
    // Group 5 is NOT post-R12 — R12 permits optional handles. This pins a
    // deliberate choice of ours, not a version rule: we emit none, and so we
    // owe no $HANDLING=1 header or $HANDSEED above every handle used. A writer
    // that starts emitting 5 must supply both, and should update this test
    // rather than delete it.
    expect(p.some(([c]) => c === '5'), 'group 5 (handle) must stay absent').toBe(false);
    expect(p.some(([c, v]) => c === '9' && v === '$HANDLING')).toBe(false);
  });
});
