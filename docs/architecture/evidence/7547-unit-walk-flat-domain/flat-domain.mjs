/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// node flat-domain.mjs <parser dist> [<parser dist> ...]
// node flat-domain.mjs --write <dir>
//
// #7547: which derived units each build of @ifc-lite/parser resolves, flat and nested, through
// two public readers on a parsed model, and what each reader reads to get there. Every model is
// generated here. It is a project whose IfcUnitAssignment lists metre #2, second #5 and the
// derived unit #60 under test. Wall #10 has a property `Speed` (IfcLinearVelocityMeasure 2.5)
// whose own Unit is #60. Each build parses the model with its own IfcParser.parseColumnar. Then
// it calls two readers.
//   assignment: extractProjectUnits(store.source, store.entityIndex), and its LINEARVELOCITYUNIT
//   own Unit:   extractPropertiesOnDemand(store, 10), and the `Speed` property's unit
//
// The first call of each reader gives the result and the entity reads it made: every call of
// that build's EntityExtractor.extractEntity, and the bytes of the records read. A reader that
// throws prints the error. A long symbol is printed as its length, its ends and a sha256
// prefix, so equal symbols show equal digests.
//
// Times: after that call, each sample times one call of the reader alone, with the counter
// removed; the result is printed from the counted call only. Builds run interleaved, the order
// rotated each round; the time is the median of ROUNDS (default 5). ROUNDS=0 prints the results
// and reads only. Cases marked untimed are never timed: on main each call parses hundreds of MB.
// At the end the script prints its peak resident memory to stderr (process.resourceUsage().maxRSS).
//
// --write <dir> writes some of the models as .ifc files, for an external schema check (README).
// They are the flat models of the review (2, 128 and 10,000 elements) and the IFC2X3 model past
// the string limit. So are the two IFC4 models over a factor with a long IfcText, and three
// controls that must fail.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const gid = (n) => String(n).padStart(22, '0');

/**
 * IFC2X3 requires what IFC4 made optional: an owner history on every rooted entity and the
 * project's representation context. Ids from #9000000 on, clear of every case's own ids.
 */
const IFC2X3_REQUIRED = [
  '#9000000=IFCOWNERHISTORY(#9000001,#9000004,$,.NOCHANGE.,$,$,$,0);', '#9000001=IFCPERSONANDORGANIZATION(#9000002,#9000003,$);',
  "#9000002=IFCPERSON($,'Probe',$,$,$,$,$,$);", "#9000003=IFCORGANIZATION($,'Probe',$,$,$);",
  "#9000004=IFCAPPLICATION(#9000003,'1','flat-domain.mjs','flat-domain');",
  "#9000005=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#9000006,$);", '#9000006=IFCAXIS2PLACEMENT3D(#9000007,$,$);',
  '#9000007=IFCCARTESIANPOINT((0.,0.,0.));',
];

/** The model around unit #60 (`unitRows`); `props` properties `Speed<i>` name it as their own Unit. */
function model(unitRows, { props = 1, schema = 'IFC4' } = {}) {
  const propIds = Array.from({ length: props }, (_, i) => 5_000_000 + i);
  const ifc2x3 = schema === 'IFC2X3';
  const owner = ifc2x3 ? '#9000000' : '$';
  return [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    "FILE_NAME('flat-domain.ifc','2026-10-13T00:00:00',(''),(''),'','','');", `FILE_SCHEMA(('${schema}'));`, 'ENDSEC;', 'DATA;',
    `#1=IFCPROJECT('${gid(1)}',${owner},'P',$,$,$,$,${ifc2x3 ? '(#9000005)' : '$'},#3);`,
    '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);', '#3=IFCUNITASSIGNMENT((#2,#5,#60));', '#5=IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.);',
    // IfcWall has no PredefinedType in IFC2X3.
    `#10=IFCWALL('${gid(10)}',${owner},'W',$,$,$,$,$${ifc2x3 ? '' : ',$'});`,
    ...(ifc2x3 ? IFC2X3_REQUIRED : []),
    ...unitRows,
    ...propIds.map((id, i) => `#${id}=IFCPROPERTYSINGLEVALUE('Speed${props === 1 ? '' : i}',$,IFCLINEARVELOCITYMEASURE(2.5),#60);`),
    `#40=IFCPROPERTYSET('${gid(40)}',${owner},'Probe_Set',$,(${propIds.map((id) => `#${id}`).join(',')}));`,
    `#41=IFCRELDEFINESBYPROPERTIES('${gid(41)}',${owner},$,$,(#10),#40);`,
    'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n');
}

/**
 * Flat LINEARVELOCITYUNIT #60, the review's shape: `pairs` cancelling (+1, -1) pairs of `length`,
 * then `length` +1 and second #5 -1, each element its own entity (#1000 on): `2 * pairs + 2`
 * elements, m/s at scale 1 over the metre. `length` is one reference, or a function that gives
 * the k-th length element its own.
 */
function velocity(pairs, length = '#2') {
  const elements = [];
  const unit = typeof length === 'function' ? length : () => length;
  for (let i = 0; i < pairs; i++) elements.push([unit(2 * i), 1], [unit(2 * i + 1), -1]);
  elements.push([unit(2 * pairs), 1], ['#5', -1]);
  return [
    `#60=IFCDERIVEDUNIT((${elements.map((_, i) => `#${1000 + i}`).join(',')}),.LINEARVELOCITYUNIT.,$);`,
    ...elements.map(([unit, exponent], i) => `#${1000 + i}=IFCDERIVEDUNITELEMENT(${unit},${exponent});`),
  ];
}

/** #60 with `n` elements (#1000 on), each naming `unit` with exponent 1, then `rows`. */
function wideOver(n, unit, rows) {
  const elements = Array.from({ length: n }, (_, i) => 1000 + i);
  return [
    `#60=IFCDERIVEDUNIT((${elements.map((e) => `#${e}`).join(',')}),.LINEARVELOCITYUNIT.,$);`,
    ...elements.map((e) => `#${e}=IFCDERIVEDUNITELEMENT(${unit},1);`),
    ...rows,
  ];
}

/** Conversion-based length unit #6 of 1 m, named by `length` L's (IfcLabel is STRING(255) in IFC4, unbounded in IFC2X3). */
const longNamed = (length) => [
  `#6=IFCCONVERSIONBASEDUNIT(#7,.LENGTHUNIT.,'${'L'.repeat(length)}',#8);`,
  '#7=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);', '#8=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#2);',
];

/**
 * Conversion-based length unit #6 'FOOT' whose factor #8 holds an IfcText of `length` characters.
 * IfcMeasureWithUnit.ValueComponent is an IfcValue, and IfcText has no length limit in IFC4. A text
 * is not a number, so the readers use FOOT's known factor, 0.3048, as before.
 */
const textFactorFoot = (length) => [
  "#6=IFCCONVERSIONBASEDUNIT(#7,.LENGTHUNIT.,'FOOT',#8);", '#7=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);',
  `#8=IFCMEASUREWITHUNIT(IFCTEXT('${'T'.repeat(length)}'),#2);`,
];

/** `n` more feet from #20000 on, each its own entity, all over factor #8 of `textFactorFoot`. */
const feetSharingFactor = (n) => Array.from({ length: n }, (_, k) => `#${20_000 + k}=IFCCONVERSIONBASEDUNIT(#7,.LENGTHUNIT.,'FOOT',#8);`);

/**
 * Malformed: #60 lists element #1000 `n` times (`Elements` is a SET, which may not), and the metre
 * #6 it names carries `pad` extra `$` attributes.
 */
const repeatedElement = (n, pad) => [
  `#60=IFCDERIVEDUNIT((${Array(n).fill('#1000').join(',')}),.LINEARVELOCITYUNIT.,$);`, '#1000=IFCDERIVEDUNITELEMENT(#6,1);',
  `#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.,${Array(pad).fill('$').join(',')});`,
];

/** Nested (outside the schema): #60 and `levels - 1` derived units below it, each listing the next `k` times, then a metre. */
function fanOut(levels, k) {
  const rows = [];
  for (let level = 0; level < levels; level++) {
    const unit = 60 + level * 10;
    const elements = Array.from({ length: k }, (_, i) => unit + 1 + i);
    rows.push(`#${unit}=IFCDERIVEDUNIT((${elements.map((e) => `#${e}`).join(',')}),.LINEARVELOCITYUNIT.,$);`,
      ...elements.map((e) => `#${e}=IFCDERIVEDUNITELEMENT(#${unit + 10},1);`));
  }
  return [...rows, `#${60 + levels * 10}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`];
}

/** Nested (outside the schema): #60 with `n` elements, each naming derived unit #50 of `m` metre elements. */
function wideOverNested(n, m) {
  const inner = Array.from({ length: m }, (_, i) => 200_000 + i);
  return wideOver(n, '#50', [
    `#50=IFCDERIVEDUNIT((${inner.map((e) => `#${e}`).join(',')}),.LINEARVELOCITYUNIT.,$);`,
    ...inner.map((e) => `#${e}=IFCDERIVEDUNITELEMENT(#2,1);`),
  ]);
}

/** Not a unit: an IfcCartesianPointList3D of `n` points, #50 (IFC4: CoordList only). */
const pointList = (n) => `#50=IFCCARTESIANPOINTLIST3D((${Array.from({ length: n }, (_, i) => `(${i}.,0.,0.)`).join(',')}));`;

/** Nested (outside the schema): derived unit #50 whose `n` elements are all `$`, so it holds no reference. */
const dollarUnit = (n) => `#50=IFCDERIVEDUNIT((${Array(n).fill('$').join(',')}),.USERDEFINED.,'inner');`;

// 2,700 elements over a 200,000-character name make a 540,002,699-character symbol, past
// V8's 536,870,888, in one Array.prototype.join: every element is in the numerator. The
// velocity shape over the same name splits it into a numerator and a denominator of about 270
// million characters each. They pass the limit only when the final template literal joins them.
const PAST_LIMIT_NAME = 200_000;

const CASES = [
  { name: 'flat, 2 elements: m/s, the control', text: () => model(velocity(0)), file: 'velocity-2.ifc' },
  { name: "flat, 128 elements: the review's example", text: () => model(velocity(63)), file: 'velocity-128.ifc' },
  { name: 'flat, 300 elements', text: () => model(velocity(149)) },
  { name: 'flat, 10,000 elements', text: () => model(velocity(4_999)), file: 'velocity-10000.ifc' },
  { name: 'flat, 100,000 elements', text: () => model(velocity(49_999)) },
  { name: 'flat, 10,000 elements over a conversion-based unit with a 255-character name', text: () => model([...longNamed(255), ...velocity(4_999, '#6')]) },
  { name: 'flat, 1,000 elements, named by 1,000 properties', text: () => model(velocity(499), { props: 1_000 }), props: 1_000 },
  {
    name: 'flat, IFC2X3: 2,700 elements over one conversion-based unit with a 200,000-character name, past the string limit in one join',
    text: () => model([...longNamed(PAST_LIMIT_NAME), ...wideOver(2_700, '#6', [])], { schema: 'IFC2X3' }),
    file: 'ifc2x3-past-string-limit.ifc', untimed: true,
  },
  {
    name: 'flat, IFC2X3: the velocity shape, 2,702 elements over the same name, past the string limit in the final concatenation',
    text: () => model([...longNamed(PAST_LIMIT_NAME), ...velocity(1_350, '#6')], { schema: 'IFC2X3' }),
    untimed: true,
  },
  {
    name: 'flat: 2,000 elements over one foot whose factor holds a 65,536-character IfcText',
    text: () => model([...textFactorFoot(65_536), ...velocity(999, '#6')]), file: 'text-factor-one-foot.ifc',
  },
  {
    name: 'flat: the same 2,000 elements, each length element over its own foot, the 1,999 feet sharing that factor',
    text: () => model([...textFactorFoot(65_536), ...feetSharingFactor(1_999), ...velocity(999, (k) => `#${20_000 + k}`)]),
    file: 'text-factor-1999-feet.ifc',
  },
  {
    name: 'malformed: #60 lists one element 20,000 times, over a metre with 16,000 extra $ attributes',
    text: () => model(repeatedElement(20_000, 16_000)), untimed: true,
  },
  { name: 'nested: a fan-out of 10 levels by 4', text: () => model(fanOut(10, 4)) },
  { name: 'nested: 10,000 elements, each naming one derived unit of 4 metres', text: () => model(wideOverNested(10_000, 4)) },
  { name: 'nested: 1,000 elements, each naming one derived unit of 1,000 metres', text: () => model(wideOverNested(1_000, 1_000)) },
  { name: 'nested: 300 elements, each naming one derived unit whose 20,000 elements are all $', text: () => model(wideOver(300, '#50', [dollarUnit(20_000)])) },
  { name: 'not a unit: 1,000 elements, each naming one IfcCartesianPointList3D of 3,000 points as its Unit', text: () => model(wideOver(1_000, '#50', [pointList(3_000)])) },
];

// Three controls for the schema check only, which must fail it. Each is the 2-element unit with
// its metre element naming #50 instead: a derived unit (a nesting), or a point list (not a unit).
// The third has UnitType USERDEFINED and no UserDefinedType.
const namingFifty = (rows) => model([...velocity(0).map((row) => row.replace('#1000=IFCDERIVEDUNITELEMENT(#2,1);', '#1000=IFCDERIVEDUNITELEMENT(#50,1);')), ...rows]);
const SCHEMA_CONTROLS = [
  { file: 'control-nested.ifc', text: () => namingFifty(['#50=IFCDERIVEDUNIT((#51,#52),.LINEARVELOCITYUNIT.,$);', '#51=IFCDERIVEDUNITELEMENT(#2,1);', '#52=IFCDERIVEDUNITELEMENT(#5,-1);']) },
  { file: 'control-not-a-unit.ifc', text: () => namingFifty([pointList(3)]) },
  { file: 'control-userdefined.ifc', text: () => model(velocity(0)).replace('.LINEARVELOCITYUNIT.,$)', '.USERDEFINED.,$)') },
];

const args = process.argv.slice(2);
if (args[0] === '--write') {
  mkdirSync(args[1], { recursive: true });
  for (const c of [...CASES.filter((x) => x.file), ...SCHEMA_CONTROLS]) {
    writeFileSync(resolve(args[1], c.file), `${c.text()}\n`);
    console.log(`wrote ${c.file}`);
  }
  process.exit(0);
}

const ROUNDS = Number(process.env.ROUNDS ?? 5);
const builds = await Promise.all(args.map(async (dir) => ({
  name: basename(resolve(dir)),
  parser: await import(pathToFileURL(resolve(dir, 'index.js')).href),
})));

const digest = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const symbolText = (s) => (s.length <= 24 ? `'${s}'` : `${s.length} chars '${s.slice(0, 8)}...${s.slice(-8)}' ${digest(s)}`);

/** Each reader: `read`, the one call that is counted and timed, and `text`, which prints its result untimed. */
const READERS = [
  { label: 'assignment:', read: (p, store) => p.extractProjectUnits(store.source, store.entityIndex), text: (units) => assignment(units) },
  { label: 'own Unit:  ', read: (p, store) => p.extractPropertiesOnDemand(store, 10), text: (sets, props) => ownUnit(sets, props) },
];

function assignment(units) {
  const declared = units.resolvedForUnitType('LINEARVELOCITYUNIT');
  const shown = units.unitForMeasure('IfcLinearVelocityMeasure');
  if (declared) return `${symbolText(declared.symbol)}, scale ${declared.siScale}`;
  if (shown === null) return `declared, no scale (${units.declaredCount} declared)`;
  return `not declared, the SI default ${symbolText(shown.symbol)} shown (${units.declaredCount} declared)`;
}

function ownUnit(sets, props) {
  const set = sets.find((s) => s.name === 'Probe_Set');
  const outcomes = new Map();
  for (const prop of set?.properties ?? []) {
    const text = prop.unitSiScale === undefined ? `unresolved, '${prop.unit}' with no scale` : `${symbolText(prop.unit)}, scale ${prop.unitSiScale}`;
    outcomes.set(text, (outcomes.get(text) ?? 0) + 1);
  }
  return [...outcomes].map(([text, n]) => (props === 1 ? text : `${n} of ${props}: ${text}`)).join('; ');
}

/** One call of `reader.read` on build `b`, with every EntityExtractor.extractEntity call of that build counted. */
function counted(b, store, reader, props) {
  const proto = b.parser.EntityExtractor.prototype;
  const extract = proto.extractEntity;
  let reads = 0;
  let bytes = 0;
  proto.extractEntity = function countedExtract(ref) {
    reads += 1;
    bytes += ref.byteLength;
    return extract.call(this, ref);
  };
  let out;
  let threw;
  try {
    out = reader.read(b.parser, store);
  } catch (error) {
    threw = `THREW ${error.name}: ${error.message}`;
  } finally {
    proto.extractEntity = extract;
  }
  const result = threw ?? reader.text(out, props);
  const kb = bytes < 10 * 1024 ? (bytes / 1024).toFixed(1) : Math.round(bytes / 1024).toLocaleString('en-US');
  return `${result}; ${reads.toLocaleString('en-US')} reads, ${kb} KB read`;
}

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
function timed(stores, reader, props, rounds) {
  const results = builds.map((b, i) => counted(b, stores[i], reader, props));
  if (rounds === 0) return results.map((result) => ({ result, ms: undefined }));
  const times = builds.map(() => []);
  for (let r = 0; r < rounds; r++) {
    for (let k = 0; k < builds.length; k++) {
      const i = (k + r) % builds.length;
      const t = performance.now();
      try {
        reader.read(builds[i].parser, stores[i]);
      } catch {
        // The counted call printed it.
      }
      times[i].push(performance.now() - t);
    }
  }
  return results.map((result, i) => ({ result, ms: median(times[i]) }));
}

const ms = (t) => (t === undefined ? 'untimed' : `${t < 10 ? t.toFixed(2) : t.toFixed(1)} ms`);
const width = Math.max(...builds.map((b) => b.name.length));
console.log(ROUNDS === 0
  ? `Node ${process.version}; ROUNDS=0: results and reads only, nothing timed`
  : `Node ${process.version}, ${cpus()[0].model.trim()}; median of ${ROUNDS} after the counted call, builds interleaved, order rotated each round`);
for (const c of CASES) {
  const text = c.text();
  const bytes = new TextEncoder().encode(text);
  const stores = [];
  for (const b of builds) {
    stores.push(await new b.parser.IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true }));
  }
  console.log(`\n${c.name} (${Math.round(bytes.byteLength / 1024).toLocaleString('en-US')} KB)`);
  const rounds = c.untimed ? 0 : ROUNDS;
  const rows = READERS.map((reader) => timed(stores, reader, c.props ?? 1, rounds));
  const time = (t) => (ROUNDS === 0 ? '' : `, ${ms(t.ms)}`);
  builds.forEach((b, i) => {
    READERS.forEach((reader, r) => {
      console.log(`  ${(r === 0 ? b.name : '').padEnd(width)}  ${reader.label} ${rows[r][i].result}${time(rows[r][i])}`);
    });
  });
}

// The peak resident memory of the whole run, every build and case (README, Results). Node gives
// maxRSS in KiB.
console.error(`maxRSS ${Math.round(process.resourceUsage().maxRSS / 1024).toLocaleString('en-US')} MiB`);
