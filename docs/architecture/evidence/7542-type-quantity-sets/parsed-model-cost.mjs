/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// node --expose-gc parsed-model-cost.mjs <scenario> <mode> <runs> <ids dist> [<ids dist> ...]
// #7542: the cost of inheriting a type's quantity sets, on a parsed model.
//
// Model, generated here: IFC4, 50,000 IfcWall over 10 IfcWallType, one IfcRelDefinesByType per
// type. Scenario `primary`: each type holds Qto_WallBaseQuantities (9 quantities: lengths, areas,
// volumes) and Pset_WallCommon (IsExternal, Reference); every 7th wall (7,143) has its own
// Qto_WallBaseQuantities holding only Length 9.5. Scenario `no-type-qto`: the same without the
// types' quantity sets (a control: then every build must give the same report). Scenario
// `own-full-set`: every wall has its own Qto_WallBaseQuantities with all 9 quantities and its
// type's values. The model is parsed with IfcParser.parseColumnar (this checkout's parser dist).
//
// IDS, passed as XML through each build's parseIDS: 15 specifications on IFCWALL, 13 of them on
// Qto_WallBaseQuantities (one per quantity, Height = 3, Length within [4, 9], an applicability
// on Length with Name required, and IFCWALLTYPE itself) and 2 on Pset_WallCommon, inherited
// before #7542 too.
//
// Mode `validate` times createDataAccessor plus validateIDS (includePassingEntities: false).
// Mode `sweep` times createDataAccessor plus getPropertySets over every wall: the bridge alone.
// Each timed run gets a freshly parsed store (the parse is not timed) after gc(), so no per-store
// cache starts warm. 3 warm-up rounds, then <runs> rounds; builds interleaved, the order
// rotated each round. Each build's report is checked against counts derived from the model,
// for a build that inherits the types' quantity sets and for one that does not.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [scenario, mode, runsArg, ...dists] = process.argv.slice(2);
const RUNS = Number(runsArg);
const WARMUPS = 3;
const WALLS = 50000, TYPES = 10;
const TYPE_QTO = scenario !== 'no-type-qto';
const OWN_EVERY = scenario === 'own-full-set' ? 1 : 7;
const OWN_FULL = scenario === 'own-full-set';
if (!['primary', 'no-type-qto', 'own-full-set'].includes(scenario) || !['validate', 'sweep'].includes(mode)) {
  throw new Error('usage: <primary|no-type-qto|own-full-set> <validate|sweep> <runs> <ids dist>...');
}
if (typeof globalThis.gc !== 'function') throw new Error('run with node --expose-gc');
const { IfcParser } = await import(new URL('../../../../packages/parser/dist/index.js', import.meta.url).href);
const builds = await Promise.all(dists.map(async (d) => ({
  name: d.split(/[\\/]/).pop(),
  ...(await import(pathToFileURL(resolve(d, 'index.js')).href)),
  ...(await import(pathToFileURL(resolve(d, 'bridge/index.js')).href)),
})));

const QTY = [['Length', 'LENGTH'], ['Width', 'LENGTH'], ['Height', 'LENGTH'], ['GrossFootprintArea', 'AREA'],
  ['NetFootprintArea', 'AREA'], ['GrossSideArea', 'AREA'], ['NetSideArea', 'AREA'], ['GrossVolume', 'VOLUME'], ['NetVolume', 'VOLUME']];
const MEASURE = { LENGTH: 'IFCLENGTHMEASURE', AREA: 'IFCAREAMEASURE', VOLUME: 'IFCVOLUMEMEASURE' };
const gid = (p, id) => p + String(id).padStart(22 - p.length, '0');
const typeLength = (t) => 4 + 0.5 * (t % 10);
const quantityValue = (t, name) => {
  const L = typeLength(t), W = 0.2, H = 3;
  return { Length: L, Width: W, Height: H, GrossFootprintArea: L * W, NetFootprintArea: L * W,
    GrossSideArea: L * H, NetSideArea: L * H - 1, GrossVolume: L * W * H, NetVolume: L * W * H - 0.1 }[name];
};
const num = (v) => { const s = String(v); return s.includes('.') || s.includes('e') ? s : `${s}.`; };

const lines = ['ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
  "FILE_NAME('cost.ifc','2026-10-13T00:00:00',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
  `#1=IFCPROJECT('${gid('0proj', 1)}',$,'P',$,$,$,$,$,#5);`, '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
  '#3=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);', '#4=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);', '#5=IFCUNITASSIGNMENT((#2,#3,#4));'];
let id = 100;
const typeIds = [];
const qset = (setId, members) => `#${setId}=IFCELEMENTQUANTITY('${gid('0qto', setId)}',$,'Qto_WallBaseQuantities',$,$,(${members.map((q) => `#${q}`).join(',')}));`;
for (let t = 0; t < TYPES; t++) {
  const typeId = id++;
  typeIds.push(typeId);
  const sets = [];
  if (TYPE_QTO) {
    const setId = id++, qIds = QTY.map(() => id++);
    sets.push(setId);
    lines.push(qset(setId, qIds));
    QTY.forEach(([name, kind], k) => lines.push(`#${qIds[k]}=IFCQUANTITY${kind}('${name}',$,$,${num(quantityValue(t, name))},$);`));
  }
  const psetId = id++, p1 = id++, p2 = id++;
  sets.push(psetId);
  lines.push(`#${psetId}=IFCPROPERTYSET('${gid('0pset', psetId)}',$,'Pset_WallCommon',$,(#${p1},#${p2}));`);
  lines.push(`#${p1}=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);`, `#${p2}=IFCPROPERTYSINGLEVALUE('Reference',$,IFCIDENTIFIER('WT${t}'),$);`);
  lines.push(`#${typeId}=IFCWALLTYPE('${gid('0type', typeId)}',$,'WT${t}',$,$,(${sets.map((s) => `#${s}`).join(',')}),$,$,$,.STANDARD.);`);
}
const byType = typeIds.map(() => []), wallIds = [];
for (let i = 0; i < WALLS; i++) {
  const wallId = id++;
  byType[i % TYPES].push(wallId);
  wallIds.push(wallId);
  lines.push(`#${wallId}=IFCWALL('${gid('0w', wallId)}',$,'W${i}',$,$,$,$,$,$);`);
  if (i % OWN_EVERY !== 0) continue;
  const setId = id++;
  if (OWN_FULL) {
    const qIds = QTY.map(() => id++);
    lines.push(qset(setId, qIds));
    QTY.forEach(([name, kind], k) => lines.push(`#${qIds[k]}=IFCQUANTITY${kind}('${name}',$,$,${num(quantityValue(i % TYPES, name))},$);`));
  } else {
    const qId = id++;
    lines.push(qset(setId, [qId]), `#${qId}=IFCQUANTITYLENGTH('Length',$,$,9.5,$);`);
  }
  const relId = id++;
  lines.push(`#${relId}=IFCRELDEFINESBYPROPERTIES('${gid('0rdbp', relId)}',$,$,$,(#${wallId}),#${setId});`);
}
typeIds.forEach((typeId, t) => {
  const relId = id++;
  lines.push(`#${relId}=IFCRELDEFINESBYTYPE('${gid('0rdbt', relId)}',$,$,$,(${byType[t].map((w) => `#${w}`).join(',')}),#${typeId});`);
});
lines.push('ENDSEC;', 'END-ISO-10303-21;');
const bytes = new TextEncoder().encode(lines.join('\n'));

const sv = (v) => `<simpleValue>${v}</simpleValue>`;
const prop = (pset, name, dataType, valueXml = '') =>
  `<property dataType="${dataType}"><propertySet>${sv(pset)}</propertySet><baseName>${sv(name)}</baseName>${valueXml}</property>`;
const spec = (name, applicability, requirements) => `<specification name="${name}" ifcVersion="IFC4"><applicability minOccurs="0" maxOccurs="unbounded">${applicability}</applicability><requirements>${requirements}</requirements></specification>`;
const walls = `<entity><name>${sv('IFCWALL')}</name></entity>`;
const Q = 'Qto_WallBaseQuantities';
const SPECS = [
  ...QTY.map(([name, kind]) => spec(`Qto ${name}`, walls, prop(Q, name, MEASURE[kind]))),
  spec('Qto Height = 3', walls, prop(Q, 'Height', 'IFCLENGTHMEASURE', `<value>${sv('3')}</value>`)),
  spec('Qto Length in [4, 9]', walls, prop(Q, 'Length', 'IFCLENGTHMEASURE',
    '<value><xs:restriction base="xs:double"><xs:minInclusive value="4"/><xs:maxInclusive value="9"/></xs:restriction></value>')),
  spec('Pset IsExternal (control)', walls, prop('Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN')),
  spec('Pset Reference (control)', walls, prop('Pset_WallCommon', 'Reference', 'IFCIDENTIFIER')),
  spec('Applicable by Qto Length', walls + prop(Q, 'Length', 'IFCLENGTHMEASURE'), `<attribute><name>${sv('Name')}</name></attribute>`),
  spec('Type itself: Qto Length', `<entity><name>${sv('IFCWALLTYPE')}</name></entity>`, prop(Q, 'Length', 'IFCLENGTHMEASURE')),
];
const IDS_XML = `<?xml version="1.0" encoding="UTF-8"?><ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema"><info><title>cost</title></info><specifications>${SPECS.join('')}</specifications></ids>`;

// [applicable, passed] per specification, for a build that inherits the types' quantity sets or not.
function expected(inheritsQto) {
  const inherits = inheritsQto && TYPE_QTO;
  const qtyPass = QTY.map(() => 0);
  let height3 = 0, inBounds = 0, hasLength = 0;
  for (let i = 0; i < WALLS; i++) {
    const hasOwn = i % OWN_EVERY === 0;
    const has = (name) => inherits || (hasOwn && (OWN_FULL || name === 'Length'));
    QTY.forEach(([name], k) => { if (has(name)) qtyPass[k]++; });
    if (has('Height')) height3++;
    if (has('Length')) {
      hasLength++;
      const L = hasOwn ? (OWN_FULL ? typeLength(i % TYPES) : 9.5) : typeLength(i % TYPES);
      if (L >= 4 && L <= 9) inBounds++;
    }
  }
  return [...qtyPass.map((p) => [WALLS, p]), [WALLS, height3], [WALLS, inBounds], [WALLS, WALLS], [WALLS, WALLS],
    [hasLength, hasLength], [TYPES, inherits ? TYPES : 0]];
}

const parse = () => new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const docs = builds.map((b) => b.parseIDS(IDS_XML));
const first = await parse();
const info = { modelId: 'cost', schemaVersion: 'IFC4', entityCount: first.entityCount };
async function once(i) {
  const store = await parse();
  globalThis.gc();
  const b = builds[i];
  const t = performance.now();
  let result;
  if (mode === 'sweep') {
    const accessor = b.createDataAccessor(store);
    let sets = 0, props = 0;
    for (const w of wallIds) for (const s of accessor.getPropertySets(w)) { sets++; props += s.properties.length; }
    result = `${sets} sets, ${props} properties`;
  } else {
    result = await b.validateIDS(docs[i], b.createDataAccessor(store), info, { includePassingEntities: false });
  }
  return { ms: performance.now() - t, result };
}
const times = builds.map(() => []), results = [];
for (let round = 0; round < WARMUPS + RUNS; round++) {
  for (let k = 0; k < builds.length; k++) {
    const i = (k + round) % builds.length;
    const { ms, result } = await once(i);
    if (round >= WARMUPS) times[i].push(ms);
    results[i] ??= result;
  }
}

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`scenario ${scenario}: ${WALLS} walls, ${TYPES} types, ${lines.filter((l) => l.startsWith("#")).length} entity lines, ${(bytes.length / 1e6).toFixed(1)} MB; `
  + `mode ${mode}; ${RUNS} runs after ${WARMUPS} warm-up rounds; node ${process.version}`);
const base = median(times[0]);
builds.forEach((b, i) => {
  const m = median(times[i]);
  let check;
  if (mode === 'sweep') check = results[i];
  else {
    const counts = results[i].specificationResults.map((s) => [s.applicableCount, s.passedCount]);
    const match = (exp) => counts.every((c, k) => c[0] === exp[k][0] && c[1] === exp[k][1]);
    check = match(expected(true)) ? 'report as derived for a build that inherits the types\' quantity sets'
      : match(expected(false)) ? 'report as derived for a build that does not inherit them' : `UNEXPECTED report ${JSON.stringify(counts)}`;
    if (!TYPE_QTO && match(expected(true))) check = 'report as derived (the types hold no quantity set)';
  }
  const change = i === 0 ? '' : ` (${((m / base - 1) * 100).toFixed(1)}% against ${builds[0].name})`;
  console.log(`  ${b.name}: median ${m.toFixed(1)} ms${change}; runs ${times[i].map((x) => x.toFixed(0)).join(', ')}; ${check}`);
});
