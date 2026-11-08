/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { renumberStepIds } from './renumber-step-ids.js';

/** Deterministic test RNG (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FZK_HAUS = resolve(REPO_ROOT, 'tests', 'models', 'ara3d', 'AC20-FZK-Haus.ifc');

const FILE = String.raw`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView] #1'),'2;1');
FILE_NAME('t.ifc','2026-11-08T00:00:00',(''),(''),'x','x','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2 = IFCDIRECTION((0.,0.,1.)) ;
#3=IFCAXIS2PLACEMENT3D(#1,#2,
  $);
#10=IFCWALL('2O2Fr$t4X7Zf8NOew3FLOH',$,'Room #205; it''s here',$,'Para \S\' #9 5',#11,$,$,.STANDARD.);
#11=IFCLOCALPLACEMENT($,#3);
/* a comment with #3 and ; */
#12=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Wkx1Kv5H2ARvw$rEkq8wE',$,$,$,(#10),#99);
ENDSEC;
END-ISO-10303-21;
`;

function records(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const m of text.matchAll(/^\s*#(\d+)\s*=\s*([A-Z0-9_]+)\(/gm)) out.set(Number(m[1]), m[2]);
  return out;
}

describe('renumberStepIds', () => {
  it('renames every instance and every reference, and nothing inside strings or the header', () => {
    const { text, idMap, danglingReferences } = renumberStepIds(FILE, { random: seeded(1) });
    expect(danglingReferences).toEqual([99]);
    expect([...idMap.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 10, 11, 12]);
    const ids = [...idMap.values()];
    expect(new Set(ids).size).toBe(6);
    expect(ids).not.toContain(99);
    expect(text).toContain("FILE_DESCRIPTION(('ViewDefinition [CoordinationView] #1'),'2;1');");
    expect(text).toContain(String.raw`'Room #205; it''s here'`);
    expect(text).toContain(String.raw`'Para \S\' #9 5'`);
    expect(text).toContain('/* a comment with #3 and ; */');
    const wall = new RegExp(String.raw`#${idMap.get(10)}=IFCWALL\(.*,#${idMap.get(11)},\$,\$,\.STANDARD\.\);`);
    expect(text).toMatch(wall);
    expect(text).toContain(`#${idMap.get(3)}=IFCAXIS2PLACEMENT3D(#${idMap.get(1)},#${idMap.get(2)},\n  $);`);
    expect(text).toContain(`(#${idMap.get(10)}),#99);`);
    // Types travel with their instances.
    const before = records(FILE);
    const after = records(text);
    for (const [oldId, newId] of idMap) expect(after.get(newId)).toBe(before.get(oldId));
  });

  it('is deterministic for a seed and differs between seeds', () => {
    expect(renumberStepIds(FILE, { random: seeded(7) }).text).toBe(renumberStepIds(FILE, { random: seeded(7) }).text);
    const variants = new Set([1, 2, 3, 4, 5, 6].map(s => renumberStepIds(FILE, { random: seeded(s) }).text));
    expect(variants.size).toBeGreaterThan(1);
  });

  it('reorders instances within DATA when asked, keeping header and trailer', () => {
    const { text, idMap } = renumberStepIds(FILE, { random: seeded(3), reorder: true });
    expect(text.startsWith(FILE.slice(0, FILE.indexOf('DATA;') + 5))).toBe(true);
    expect(text.endsWith('ENDSEC;\nEND-ISO-10303-21;\n')).toBe(true);
    const after = records(text);
    const before = records(FILE);
    for (const [oldId, newId] of idMap) expect(after.get(newId)).toBe(before.get(oldId));
  });

  it('never gives an instance the id of a dangling reference', () => {
    // #2 is referenced but not declared; the three instances must not receive 2.
    const file = 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=IFCLOCALPLACEMENT(#2,#3);\n#3=IFCAXIS2PLACEMENT3D(#4,$,$);\n#4=IFCCARTESIANPOINT((0.,0.,0.));\nENDSEC;\nEND-ISO-10303-21;\n';
    for (const seed of [1, 2, 3, 4, 5]) {
      const { text, idMap, danglingReferences } = renumberStepIds(file, { random: seeded(seed) });
      expect(danglingReferences).toEqual([2]);
      expect([...idMap.values()].sort()).toEqual([1, 3, 4]);
      expect(text).toContain(`IFCLOCALPLACEMENT(#2,#${idMap.get(3)});`);
    }
  });

  it('a #id inside a comment within a record is neither a reference nor rewritten', () => {
    const file = 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=IFCCARTESIANPOINT((/* #2 */0.,0.,0.));\n#5=IFCDIRECTION(/* it\'s #1 */(0.,0.,1.));\nENDSEC;\nEND-ISO-10303-21;\n';
    const { text, danglingReferences } = renumberStepIds(file, { random: seeded(4) });
    expect(danglingReferences).toEqual([]);
    expect(text).toContain('/* #2 */0.,0.,0.');
    expect(text).toContain("/* it's #1 */(0.,0.,1.)");
  });

  it('rewrites ANCHOR and REFERENCE sections and leaves <uri> literals alone (ISO 10303-21 ed. 3)', () => {
    const file = [
      'ISO-10303-21;', 'HEADER;', 'ENDSEC;',
      'ANCHOR;', '<a>=#1;', '<b>=#2;', 'ENDSEC;',
      'REFERENCE;', '#12=<http://example.org/lib.ifc#12>;', 'ENDSEC;',
      'DATA;', '#1=IFCCARTESIANPOINT((0.,0.,0.));', '#2=IFCAXIS2PLACEMENT3D(#1,#12,$);', 'ENDSEC;',
      'END-ISO-10303-21;', '',
    ].join('\n');
    // A source returning 0 swaps the instances, which a DATA-only rewrite would miss in ANCHOR.
    const { text, idMap, danglingReferences } = renumberStepIds(file, { random: () => 0 });
    expect(danglingReferences).toEqual([]);
    expect([...idMap.keys()].sort((x, y) => x - y)).toEqual([1, 2, 12]);
    expect(text).toContain(`<a>=#${idMap.get(1)};`);
    expect(text).toContain(`<b>=#${idMap.get(2)};`);
    expect(text).toContain(`#${idMap.get(12)}=<http://example.org/lib.ifc#12>;`);
    expect(text).toContain(`IFCAXIS2PLACEMENT3D(#${idMap.get(1)},#${idMap.get(12)},$);`);
  });

  it('rejects a file that declares an instance twice', () => {
    expect(() => renumberStepIds(FILE.replace('#11=IFCLOCALPLACEMENT', '#10=IFCLOCALPLACEMENT'), { random: seeded(1) }))
      .toThrow(/declared twice/);
  });

  // Fixtures are not committed (AGENTS.md): skipped when absent, fetched with `pnpm fixtures`.
  it.skipIf(!existsSync(FZK_HAUS))('a real authoring-tool export (AC20-FZK-Haus) reads back with the same instances and GlobalIds', async () => {
    const source = readFileSync(FZK_HAUS, 'latin1');
    const { text, idMap } = renumberStepIds(source, { random: seeded(42), reorder: true });
    const parse = (t: string) => new IfcParser().parseColumnar(new TextEncoder().encode(t).buffer as ArrayBuffer);
    const [a, b] = await Promise.all([parse(source), parse(text)]);
    expect(b.entityIndex.byId.size).toBe(a.entityIndex.byId.size);
    for (const [type, ids] of a.entityIndex.byType) expect(b.entityIndex.byType.get(type)?.length).toBe(ids.length);
    // Every rooted instance keeps its GlobalId under its new #id.
    const guid = (store: Awaited<ReturnType<typeof parse>>, id: number) => store.entities.getGlobalId(id);
    let checked = 0;
    for (const [oldId, newId] of idMap) {
      const g = guid(a, oldId);
      if (!g) continue;
      expect(guid(b, newId)).toBe(g);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });
});
