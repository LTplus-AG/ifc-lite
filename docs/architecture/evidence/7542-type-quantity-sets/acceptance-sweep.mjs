/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// node acceptance-sweep.mjs <ids dist> [<ids dist> ...]
// #7542: no input that returns on one build may throw on another, and where the builds differ.
// The last build is the reference. For every entity of every model, each build is called
// through its public bridge functions, and its result is compared with the reference's:
//   1. getPropertySets through createDataAccessor, every set as name{item=value:dataType};
//   2. propertyValueToRaw for every entry the reference reports, plus one entry no entity has,
//      with dataType undefined, IFCLENGTHMEASURE and IFCLABEL, and values 1.5, 'x' and true;
//   3. getPropertySets with an overlay that deletes the second of those entries and sets every
//      other one to 2.5 (IFCLENGTHMEASURE), which also adds the missing one.
// Each entity list also holds five ids no entity has: 0, -1, 2^31, NaN and 1.5. On a model with
// more than 20,000 ids only the first three entries of each entity are corrected.
//
// Models: every .ifc file the repository tracks (git ls-files) of at most 5 MB, read from this
// checkout, and 8 generated below with shapes a type's quantity sets can take. Parsed with
// IfcParser.parseColumnar (this checkout's parser dist).
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const { IfcParser } = await import(new URL('../../../../packages/parser/dist/index.js', import.meta.url).href);
const builds = await Promise.all(process.argv.slice(2).map(async (d) => ({
  name: d.split(/[\\/]/).pop(),
  ...(await import(pathToFileURL(resolve(d, 'bridge/index.js')).href)),
})));
const ref = builds.length - 1;

const gid = (p, id) => p + String(id).padStart(22 - p.length, '0');
const wrap = (schema, body, unit = '$,.METRE.') => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('probe.ifc','2026-10-13T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
#1=IFCPROJECT('${gid('0proj', 1)}',$,'P',$,$,$,$,$,#3);
#2=IFCSIUNIT(*,.LENGTHUNIT.,${unit});
#3=IFCUNITASSIGNMENT((#2));
#4=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#5=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
${body}
ENDSEC;
END-ISO-10303-21;
`;
const GENERATED = {
  // The type holds a quantity set and a property set with millimetre Units; W2 its own quantity set.
  'base-metre': wrap('IFC4', `#20=IFCWALL('${gid('0w', 20)}',$,'W1',$,$,$,$,$,$);
#21=IFCWALL('${gid('0w', 21)}',$,'W2',$,$,$,$,$,$);
#50=IFCWALLTYPE('${gid('0t', 50)}',$,'WT',$,$,(#51,#53),$,$,$,.STANDARD.);
#51=IFCELEMENTQUANTITY('${gid('0q', 51)}',$,'Qto_WallBaseQuantities',$,$,(#52,#56));
#52=IFCQUANTITYLENGTH('Length',$,#4,5000.,$);
#56=IFCQUANTITYAREA('GrossSideArea',$,$,12.,$);
#53=IFCPROPERTYSET('${gid('0p', 53)}',$,'Pset_WallCommon',$,(#54));
#54=IFCPROPERTYSINGLEVALUE('Width',$,IFCLENGTHMEASURE(200.),#4);
#55=IFCRELDEFINESBYTYPE('${gid('0r', 55)}',$,$,$,(#20,#21),#50);
#60=IFCELEMENTQUANTITY('${gid('0q', 60)}',$,'Qto_WallBaseQuantities',$,$,(#61));
#61=IFCQUANTITYLENGTH('Height',$,#4,3000.,$);
#62=IFCRELDEFINESBYPROPERTIES('${gid('0r', 62)}',$,$,$,(#21),#60);`),
  // The type holds a quantity set, and a property set is attached to it by IfcRelDefinesByProperties.
  'type-also-rel': wrap('IFC4', `#20=IFCWALL('${gid('0w', 20)}',$,'W1',$,$,$,$,$,$);
#50=IFCWALLTYPE('${gid('0t', 50)}',$,'WT',$,$,(#51),$,$,$,.STANDARD.);
#51=IFCELEMENTQUANTITY('${gid('0q', 51)}',$,'Qto_WallBaseQuantities',$,$,(#52));
#52=IFCQUANTITYLENGTH('Length',$,#4,5000.,$);
#55=IFCRELDEFINESBYTYPE('${gid('0r', 55)}',$,$,$,(#20),#50);
#70=IFCPROPERTYSET('${gid('0p', 70)}',$,'Pset_ViaRel',$,(#71));
#71=IFCPROPERTYSINGLEVALUE('Note',$,IFCLABEL('x'),$);
#72=IFCRELDEFINESBYPROPERTIES('${gid('0r', 72)}',$,$,$,(#50),#70);`),
  // A process and its type: a type object that is not a product type.
  'task-type': wrap('IFC4', `#20=IFCTASK('${gid('0k', 20)}',$,'T1',$,$,$,$,$,$,.F.,$,$,$);
#50=IFCTASKTYPE('${gid('0t', 50)}',$,'TT',$,$,(#51),$,$,$,.CONSTRUCTION.,$);
#51=IFCELEMENTQUANTITY('${gid('0q', 51)}',$,'Qto_Task',$,$,(#52));
#52=IFCQUANTITYLENGTH('Length',$,#4,5000.,$);
#55=IFCRELDEFINESBYTYPE('${gid('0r', 55)}',$,$,$,(#20),#50);`),
  // An IFC2X3 door style holding a quantity set, and a door typed by it.
  'ifc2x3-door-style': wrap('IFC2X3', `#20=IFCDOOR('${gid('0d', 20)}',$,'D1',$,$,$,$,$,2.1,0.9);
#50=IFCDOORSTYLE('${gid('0t', 50)}',$,'DS',$,$,(#51),$,$,.SINGLE_SWING_LEFT.,.NOTDEFINED.,.F.,.F.);
#51=IFCELEMENTQUANTITY('${gid('0q', 51)}',$,'Qto_DoorBaseQuantities',$,$,(#52));
#52=IFCQUANTITYLENGTH('Width',$,#4,900.,$);
#55=IFCRELDEFINESBYTYPE('${gid('0r', 55)}',$,$,$,(#20),#50);`),
  // Broken references in the type's sets: a Unit to nothing and to a wall, lists with junk.
  'broken-refs': wrap('IFC4', `#20=IFCWALL('${gid('0w', 20)}',$,'W1',$,$,$,$,$,$);
#50=IFCWALLTYPE('${gid('0t', 50)}',$,'WT',$,$,(#51,#999,#50,#20),$,$,$,.STANDARD.);
#51=IFCELEMENTQUANTITY('${gid('0q', 51)}',$,'Qto_WallBaseQuantities',$,$,(#52,#53,#998,#51));
#52=IFCQUANTITYLENGTH('Length',$,#997,5000.,$);
#53=IFCQUANTITYLENGTH('Width',$,#20,200.,$);
#55=IFCRELDEFINESBYTYPE('${gid('0r', 55)}',$,$,$,(#20),#50);`),
  // A type whose HasPropertySets is $, and one whose quantity set has no name.
  'null-sets': wrap('IFC4', `#20=IFCWALL('${gid('0w', 20)}',$,'W1',$,$,$,$,$,$);
#21=IFCWALL('${gid('0w', 21)}',$,'W2',$,$,$,$,$,$);
#50=IFCWALLTYPE('${gid('0t', 50)}',$,'WT',$,$,$,$,$,$,.STANDARD.);
#55=IFCRELDEFINESBYTYPE('${gid('0r', 55)}',$,$,$,(#20),#50);
#60=IFCWALLTYPE('${gid('0t', 60)}',$,'WT2',$,$,(#61),$,$,$,.STANDARD.);
#61=IFCELEMENTQUANTITY('${gid('0q', 61)}',$,$,$,$,(#62));
#62=IFCQUANTITYLENGTH('Length',$,#4,5000.,$);
#65=IFCRELDEFINESBYTYPE('${gid('0r', 65)}',$,$,$,(#21),#60);`),
  // A wall typed twice (invalid), the second type holding a quantity set.
  'two-types': wrap('IFC4', `#20=IFCWALL('${gid('0w', 20)}',$,'W1',$,$,$,$,$,$);
#50=IFCWALLTYPE('${gid('0t', 50)}',$,'WT',$,$,$,$,$,$,.STANDARD.);
#55=IFCRELDEFINESBYTYPE('${gid('0r', 55)}',$,$,$,(#20),#50);
#60=IFCWALLTYPE('${gid('0t', 60)}',$,'WT2',$,$,(#61),$,$,$,.STANDARD.);
#61=IFCELEMENTQUANTITY('${gid('0q', 61)}',$,'Qto_WallBaseQuantities',$,$,(#62));
#62=IFCQUANTITYLENGTH('Length',$,#4,5000.,$);
#65=IFCRELDEFINESBYTYPE('${gid('0r', 65)}',$,$,$,(#20),#60);`),
  // A millimetre project: the type's quantity without a Unit of its own, and with a metre Unit.
  'mm-project': wrap('IFC4', `#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCWALL('${gid('0w', 20)}',$,'W1',$,$,$,$,$,$);
#50=IFCWALLTYPE('${gid('0t', 50)}',$,'WT',$,$,(#51),$,$,$,.STANDARD.);
#51=IFCELEMENTQUANTITY('${gid('0q', 51)}',$,'Qto_WallBaseQuantities',$,$,(#52,#53));
#52=IFCQUANTITYLENGTH('Length',$,$,5000.,$);
#53=IFCQUANTITYLENGTH('Width',$,#6,0.2,$);
#55=IFCRELDEFINESBYTYPE('${gid('0r', 55)}',$,$,$,(#20),#50);`, '.MILLI.,.METRE.'),
};

const tracked = execFileSync('git', ['ls-files', '-z', '*.ifc'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean).sort();
const kept = tracked.filter((f) => statSync(resolve(root, f)).size <= 5 * 1024 * 1024);
const sources = [
  { label: `tracked .ifc files of at most 5 MB (${kept.length} of ${tracked.length})`, models: kept.map((f) => [f, () => readFileSync(resolve(root, f))]) },
  { label: 'generated models', models: Object.entries(GENERATED).map(([n, t]) => [`generated:${n}`, () => new TextEncoder().encode(t)]) },
];

const fmt = (v) => (typeof v === 'number' ? (Number.isNaN(v) ? 'NaN' : String(Number(v.toPrecision(12)))) : JSON.stringify(v));
const digest = (sets) => sets.map((s) => `${s.name}{${s.properties.map((p) => `${p.name}=${fmt(p.value)}:${p.dataType ?? ''}`).join(',')}}`).join(' ');
const tryRun = (f) => { try { return { ok: true, v: f() }; } catch (e) { return { ok: false, v: `THROW ${e?.name}: ${String(e?.message).slice(0, 80)}` }; } };

for (const { label, models } of sources) {
  const totals = { models: 0, ids: 0, raws: 0, parseFailed: 0 };
  const diffs = new Map();
  const note = (key, example) => {
    let d = diffs.get(key);
    if (!d) diffs.set(key, (d = { count: 0, examples: [] }));
    d.count++;
    if (d.examples.length < 4) d.examples.push(example);
  };
  const compare = (kind, results, where) => {
    for (let i = 0; i < builds.length - 1; i++) {
      const vs = `${builds[i].name} vs ${builds[ref].name}`;
      if (results[i].ok !== results[ref].ok) note(`${kind} throws on one build, returns on the other, ${vs}`, `${where}: ${results[i].v} | ${results[ref].v}`);
      else if (results[i].v !== results[ref].v) note(`${kind} differs, ${vs}`, `${where}: ${String(results[i].v).slice(0, 160)} | ${String(results[ref].v).slice(0, 160)}`);
    }
    results.forEach((r, i) => { if (!r.ok) note(`${kind} throws on ${builds[i].name}`, `${where}: ${r.v}`); });
  };
  for (const [name, read] of models) {
    const bytes = read();
    let store;
    try {
      store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    } catch { totals.parseFailed++; continue; }
    totals.models++;
    // @raw-entity-enumeration-ok evidence script: every parsed id, to call the bridge on each
    const ids = [...store.entityIndex.byId.keys(), 0, -1, 2 ** 31, Number.NaN, 1.5];
    const big = ids.length > 20000;
    const plain = builds.map((B) => B.createDataAccessor(store));
    for (const id of ids) {
      totals.ids++;
      compare('getPropertySets', plain.map((a) => tryRun(() => digest(a.getPropertySets(id)))), `${name} #${fmt(id)}`);
      const refSets = tryRun(() => plain[ref].getPropertySets(id));
      const pairs = [['Pset_ReviewProbe', 'Missing']];
      if (refSets.ok) for (const s of refSets.v) for (const p of s.properties) pairs.push([s.name, p.name]);
      const limited = big ? pairs.slice(0, 3) : pairs;
      for (const [pset, prop] of limited) {
        for (const dt of [undefined, 'IFCLENGTHMEASURE', 'IFCLABEL']) {
          for (const value of [1.5, 'x', true]) {
            totals.raws++;
            compare('propertyValueToRaw', builds.map((B) => tryRun(() => fmt(B.propertyValueToRaw(store, id, pset, prop, dt, value)))),
              `${name} #${fmt(id)} ${pset}.${prop} ${dt} ${fmt(value)}`);
          }
        }
      }
      const overrides = limited.map(([pset, prop], k) => (k === 1
        ? { psetName: pset, propName: prop, value: null, deleted: true }
        : { psetName: pset, propName: prop, value: 2.5, dataType: 'IFCLENGTHMEASURE' }));
      compare('getPropertySets with an overlay',
        builds.map((B) => tryRun(() => digest(B.createDataAccessor(store, (e) => (e === id ? overrides : undefined)).getPropertySets(id)))),
        `${name} #${fmt(id)}`);
    }
  }
  console.log(`${label}: ${totals.models} parsed, ${totals.parseFailed} failed to parse; ${totals.ids} ids; ${totals.raws} propertyValueToRaw calls per build`);
  if (diffs.size === 0) console.log('  no difference, and nothing throws');
  for (const [k, d] of [...diffs].sort()) {
    console.log(`  ${k}: ${d.count}`);
    for (const e of d.examples) console.log(`    ${e}`);
  }
}
