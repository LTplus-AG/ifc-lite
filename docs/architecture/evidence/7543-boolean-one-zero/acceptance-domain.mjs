/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7543 acceptance domain: an old build of @ifc-lite/ids against a new one,
// with the same inputs, in one process.
//
//   node acceptance-domain.mjs <builds dir> [old build, default main] [new build, default head]
//
// The builds are the folders make-builds.mjs writes. Each call is run on
// both builds. Its outcome is the value it returned or the error it threw.
// Each pair of outcomes is one of:
//   same; changed (both returned, different values);
//   NARROWED (old returned, new threw); widened (old threw, new returned);
//   both threw.
// Every changed outcome is then tested against the one class the change is
// meant to touch, and anything outside it is printed in full:
// - for a public function, a literal "1" or "0" (as a simple value or an
//   enumeration value) against a stored value that is the boolean the literal
//   names ("1" names true, "0" names false). validateIDS is tested per entity:
//   every entity row that changes must hold, for the facet's subject, the
//   boolean the literal names;
// - for literalCastsUnder, literalCastsUnderAnyType and isBooleanLiteral,
//   which see no stored value, a literal "1" or "0" (under xs:boolean);
// - for compareBoolean, a literal "1" or "0" against any stored value. The
//   report splits its changes into the two kinds there are.
// In the code below, "main" is the old side and "branch" the new one.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.argv[2];
if (!ROOT) throw new Error('usage: node acceptance-domain.mjs <builds dir> [old build, default main] [new build, default head]');
const SIDE = { main: process.argv[3] ?? 'main', branch: process.argv[4] ?? 'head' };
const load = (b, rel) => import(pathToFileURL(join(ROOT, SIDE[b], 'dist', rel)).href);
const B = {};
for (const b of ['main', 'branch']) {
  B[b] = {
    cast: await load(b, 'constraints/xsd-cast.js'),
    cmp: await load(b, 'constraints/comparators.js'),
    lex: await load(b, 'constraints/xsd-lexical.js'),
    prop: await load(b, 'facets/property-facet.js'),
    ids: await load(b, 'index.js'),
    bridge: await load(b, 'bridge/index.js'),
  };
}
const { IfcParser } = await import(pathToFileURL(join(ROOT, SIDE.branch, 'node_modules', '@ifc-lite', 'parser', 'dist', 'index.js')).href);

// ---------------------------------------------------------------- outcomes
function canon(x) {
  return JSON.stringify(x, (_k, v) => {
    if (v === undefined) return '__undefined';
    if (typeof v === 'number' && !Number.isFinite(v)) return `__num:${v}`;
    if (Object.is(v, -0)) return '__-0';
    if (typeof v === 'bigint') return `__bigint:${v}`;
    if (typeof v === 'symbol') return `__symbol:${String(v)}`;
    return v;
  });
}
function show(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'symbol') return String(v);
  if (Object.is(v, -0)) return '-0';
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === null) return 'Object.create(null)';
  if (v instanceof String) return `new String(${JSON.stringify(String(v))})`;
  if (v && typeof v === 'object' && Object.hasOwn(v, 'toString')) {
    try { return `{ toString() returns ${JSON.stringify(String(v))} }`; } catch { return '{ toString() throws }'; }
  }
  try { return canon(v) ?? String(v); } catch { return '(unprintable)'; }
}
const run = (fn) => { try { return { ok: canon(fn()) }; } catch (e) { return { threw: `${e?.constructor?.name}: ${e?.message}` }; } };
const runAsync = async (fn) => { try { return { ok: canon(await fn()) }; } catch (e) { return { threw: `${e?.constructor?.name}: ${e?.message}` }; } };

const OLD = SIDE.main;
const NEW = SIDE.branch;
const tallies = new Map();
const outside = [];
const changedSamples = new Map();
const bothThrew = new Map();
function record(fnName, inputLabel, m, b, inClass) {
  let t = tallies.get(fnName);
  if (!t) { t = { calls: 0, same: 0, changed: 0, narrowed: 0, widened: 0, bothThrew: 0, changedOutsideClass: 0 }; tallies.set(fnName, t); }
  t.calls++;
  if ('ok' in m && 'ok' in b) {
    if (m.ok === b.ok) { t.same++; return; }
    t.changed++;
    const samples = changedSamples.get(fnName) ?? [];
    if (samples.length < 6) samples.push(`${inputLabel}: ${OLD} ${m.ok}, ${NEW} ${b.ok}`);
    changedSamples.set(fnName, samples);
    if (!inClass()) { t.changedOutsideClass++; outside.push(`${fnName} ${inputLabel}: ${OLD} ${m.ok}, ${NEW} ${b.ok}`); }
  } else if ('ok' in m) {
    t.narrowed++; outside.push(`NARROWED ${fnName} ${inputLabel}: ${OLD} ${m.ok}, ${NEW} threw ${b.threw}`);
  } else if ('ok' in b) {
    t.widened++; outside.push(`widened ${fnName} ${inputLabel}: ${OLD} threw ${m.threw}, ${NEW} ${b.ok}`);
  } else {
    t.bothThrew++;
    const key = `${fnName} | ${m.threw}`;
    const seen = bothThrew.get(key) ?? { count: 0, examples: [] };
    seen.count++;
    if (seen.examples.length < 2) seen.examples.push(inputLabel);
    bothThrew.set(key, seen);
    if (m.threw !== b.threw) outside.push(`both threw, differently: ${fnName} ${inputLabel}: ${OLD} ${m.threw}, ${NEW} ${b.threw}`);
  }
}

// ------------------------------------------------------------------ inputs
const ALPHABET = ['0', '1', 't', 'f', 'T', 'F', ' ', '-', '+', '.', 'e'];
const STRINGS = new Set(['']);
for (const a of ALPHABET) { STRINGS.add(a); for (const c of ALPHABET) STRINGS.add(a + c); }
for (const s of ['true', 'false', 'TRUE', 'True', 'FALSE', 'False', 'trUe', 'tRUE', '.T.', '.F.', '.U.', 'yes', 'no',
  '1.0', '0.0', '1e0', '0e0', '10', '01', '00', '001', '2', '-1', '0.5', 'NaN', '+INF', '-INF', 'UNKNOWN', 'U', 'null', 'undefined',
  ' true', 'true ', 'true\n', '1\n', '\n1', '\t0', ' 1', '1 ', '0 ', '١', '٠', '１', '０', '1\u0000', '\u200B1', 'P1D', '2024-01-01']) STRINGS.add(s);
const LITERALS = [...STRINGS];
const NON_STRINGS = [1, 0, -0, 2, true, false, null, undefined, NaN, 1n, 0n, [], ['1'], [1], {}, { toString() { return '1'; } },
  new String('1'), new String('true'), Symbol('1'), Object.create(null), { toString() { throw new Error('toString throws'); } }];
const ALL_VALUES = [...LITERALS, ...NON_STRINGS];
const XSD_TYPES = ['xs:boolean', 'xs:string', 'xs:integer', 'xs:double', 'xs:float', 'xs:decimal', 'xs:duration', 'xs:date',
  'xs:dateTime', 'xs:time', 'xs:anyURI', 'xs:normalizedString', '', 'xs:BOOLEAN', 'boolean', undefined, null];
const ACTUALS = [true, false, 'true', 'false', '1', '0', 'TRUE', '.T.', '.F.', 'UNKNOWN', 1, 0, -0, 2, 1.0000001, NaN, '', 'x', null, undefined];
const OPTIONS = [undefined, { caseInsensitive: true }, { stringOnly: true }, { caseInsensitive: true, stringOnly: true }];
const ONE_ZERO = new Set(['1', '0']);
const named = (l) => l === '1';

// ------------------------------------------- the changed functions themselves
for (const v of ALL_VALUES) for (const t of XSD_TYPES) {
  record('literalCastsUnder (module)', `(${show(v)}, ${show(t)})`, run(() => B.main.cast.literalCastsUnder(v, t)), run(() => B.branch.cast.literalCastsUnder(v, t)),
    () => ONE_ZERO.has(v) && t === 'xs:boolean');
}
for (const v of ALL_VALUES) for (const ts of [['xs:boolean'], ['xs:boolean', 'xs:string'], ['xs:string', 'xs:boolean'], [], ['xs:integer'], ['xs:double'], ['xs:string']]) {
  record('literalCastsUnderAnyType (module)', `(${show(v)}, ${show(ts)})`, run(() => B.main.cast.literalCastsUnderAnyType(v, ts)), run(() => B.branch.cast.literalCastsUnderAnyType(v, ts)),
    () => ONE_ZERO.has(v) && ts.includes('xs:boolean'));
}
for (const v of ALL_VALUES) {
  record('isBooleanLiteral (module)', `(${show(v)})`, run(() => B.main.cmp.isBooleanLiteral(v)), run(() => B.branch.cmp.isBooleanLiteral(v)), () => ONE_ZERO.has(v));
}
// compareBoolean's changes come in two kinds; the report counts each.
const compareBooleanKinds = { nowTrue: 0, undefinedToFalse: 0, other: 0 };
for (const e of ALL_VALUES) for (const a of ACTUALS) {
  const m = run(() => B.main.cmp.compareBoolean(e, a));
  const b = run(() => B.branch.cmp.compareBoolean(e, a));
  record('compareBoolean (module)', `(${show(e)}, ${show(a)})`, m, b, () => ONE_ZERO.has(e));
  if (!('ok' in m && 'ok' in b) || m.ok === b.ok) continue;
  if (m.ok === canon(undefined) && b.ok === canon(true) && typeof a === 'boolean' && ONE_ZERO.has(e) && named(e) === a) compareBooleanKinds.nowTrue++;
  else if (m.ok === canon(undefined) && b.ok === canon(false)) compareBooleanKinds.undefinedToFalse++;
  else compareBooleanKinds.other++;
}
for (const v of ALL_VALUES) for (const t of XSD_TYPES) {
  record('isValidLexicalForXsType (module)', `(${show(v)}, ${show(t)})`, run(() => B.main.lex.isValidLexicalForXsType(v, t)), run(() => B.branch.lex.isValidLexicalForXsType(v, t)),
    () => false);
}

// ------------------------------------------------------ public: constraints
const sv = (value) => ({ type: 'simpleValue', value });
function constraintsFor(l) {
  const out = [[`simpleValue ${show(l)}`, sv(l)]];
  for (const base of [undefined, 'xs:boolean', 'xs:string', 'xs:integer', 'xs:double']) {
    out.push([`enumeration [${show(l)}] base ${base}`, { type: 'enumeration', values: [l], ...(base ? { base } : {}) }]);
  }
  out.push([`enumeration [${show(l)}, "x"]`, { type: 'enumeration', values: [l, 'x'] }]);
  out.push([`enumeration [${show(l)}] and pattern "x"`, { type: 'enumeration', values: [l], base: 'xs:boolean', and: [{ type: 'pattern', pattern: 'x', base: 'xs:boolean' }] }]);
  if (typeof l === 'string' && /^[0-9a-zA-Z|.\- ]*$/.test(l)) out.push([`pattern ${show(l)} base xs:boolean`, { type: 'pattern', pattern: l, base: 'xs:boolean' }]);
  return out;
}
const FIXED_CONSTRAINTS = [
  ['pattern [01]', { type: 'pattern', pattern: '[01]', base: 'xs:boolean' }],
  ['pattern true|1', { type: 'pattern', pattern: 'true|1', base: 'xs:boolean' }],
  ['bounds min 0 max 1 xs:integer', { type: 'bounds', minInclusive: 0, maxInclusive: 1, base: 'xs:integer' }],
  ['bounds length 1', { type: 'bounds', length: 1, base: 'xs:string' }],
];
const inMatchClass = (c, a) => {
  if (typeof a !== 'boolean') return false;
  const lits = c.type === 'simpleValue' ? [c.value] : c.type === 'enumeration' ? c.values : [];
  return lits.some((l) => ONE_ZERO.has(l) && named(l) === a);
};
const allConstraints = [...ALL_VALUES.flatMap((l) => constraintsFor(l).map(([label, c]) => [label, c])), ...FIXED_CONSTRAINTS];
for (const [label, c] of allConstraints) {
  for (const a of ACTUALS) {
    for (const o of OPTIONS) {
      record('matchConstraint', `(${label}, ${show(a)}, ${show(o)})`, run(() => B.main.ids.matchConstraint(c, a, o)), run(() => B.branch.ids.matchConstraint(c, a, o)),
        () => inMatchClass(c, a) && !(o?.stringOnly));
    }
    record('getConstraintMismatchReason', `(${label}, ${show(a)})`, run(() => B.main.ids.getConstraintMismatchReason(c, a)), run(() => B.branch.ids.getConstraintMismatchReason(c, a)),
      () => typeof a === 'boolean' && c.and !== undefined && c.values?.some((l) => ONE_ZERO.has(l)));
  }
  record('formatConstraint', `(${label})`, run(() => B.main.ids.formatConstraint(c)), run(() => B.branch.ids.formatConstraint(c)), () => false);
}

// --------------------------------------------- public: facets on a parsed model
const gid = (n) => String(n).padStart(22, '0');
const PROPS = [
  ['Flag', 'IFCBOOLEAN(.T.)'], ['Off', 'IFCBOOLEAN(.F.)'], ['LogT', 'IFCLOGICAL(.T.)'], ['LogF', 'IFCLOGICAL(.F.)'], ['LogU', 'IFCLOGICAL(.U.)'],
  ['LabelTrue', "IFCLABEL('true')"], ['LabelOne', "IFCLABEL('1')"], ['LabelZero', "IFCLABEL('0')"], ['TextOne', "IFCTEXT('1')"], ['IdentZero', "IFCIDENTIFIER('0')"],
  ['IntOne', 'IFCINTEGER(1)'], ['IntZero', 'IFCINTEGER(0)'], ['RealOne', 'IFCREAL(1.)'], ['CountOne', 'IFCCOUNTMEASURE(1.)'],
];
function model(schema) {
  const wall = schema === 'IFC2X3' ? `#10=IFCWALL('${gid(10)}',$,'W',$,$,$,$,$);` : `#10=IFCWALL('${gid(10)}',$,'W',$,$,$,$,$,$);`;
  const tasks = schema === 'IFC2X3'
    ? `#30=IFCTASK('${gid(30)}',$,'T',$,$,'T1',$,$,.T.,$);\n#31=IFCTASK('${gid(31)}',$,'U',$,$,'T2',$,$,.F.,$);`
    : `#30=IFCTASK('${gid(30)}',$,'T',$,$,$,$,$,$,.T.,$,$,$);\n#31=IFCTASK('${gid(31)}',$,'U',$,$,$,$,$,$,.F.,$,$,$);`;
  const props = PROPS.map(([n, v], i) => `#${100 + i}=IFCPROPERTYSINGLEVALUE('${n}',$,${v},$);`);
  props.push(`#${100 + PROPS.length}=IFCPROPERTYENUMERATEDVALUE('EnumBool',$,(IFCBOOLEAN(.T.)),$);`);
  props.push(`#${101 + PROPS.length}=IFCPROPERTYLISTVALUE('ListBool',$,(IFCBOOLEAN(.T.),IFCBOOLEAN(.F.)),$);`);
  const refs = props.map((_, i) => `#${100 + i}`).join(',');
  return `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('t','',(''),(''),'','','');FILE_SCHEMA(('${schema}'));ENDSEC;
DATA;
#1=IFCPROJECT('${gid(1)}',$,'Project',$,$,$,$,$,#3);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCUNITASSIGNMENT((#2));
${wall}
${props.join('\n')}
#200=IFCPROPERTYSET('${gid(200)}',$,'Probe_Set',$,(${refs}));
#201=IFCRELDEFINESBYPROPERTIES('${gid(201)}',$,$,$,(#10),#200);
${tasks}
ENDSEC;
END-ISO-10303-21;
`;
}
const PROP_NAMES = [...PROPS.map(([n]) => n), 'EnumBool', 'ListBool'];
const STORED_BOOLEAN = { Flag: [true], Off: [false], LogT: [true], LogF: [false] };
const literalsOf = (value) => (value.type === 'simpleValue' ? [value.value] : value.values);
const silence = () => { const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {}; return () => { console.warn = w; console.log = l; }; };
async function parse(text) {
  const bytes = new TextEncoder().encode(text);
  const restore = silence();
  try { return await new IfcParser().parseColumnar(bytes.buffer.slice(0), { disableWorkerScan: true }); } finally { restore(); }
}

const FACET_LITERALS = LITERALS.filter((l) => !l.includes('\u0000'));
for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3_ADD2']) {
  const store = await parse(model(schema));
  const acc = { main: B.main.bridge.createDataAccessor(store), branch: B.branch.bridge.createDataAccessor(store) };
  for (const l of FACET_LITERALS) {
    const valueForms = constraintsFor(l).filter(([label]) => !label.startsWith('pattern'));
    for (const name of PROP_NAMES) {
      for (const dt of [undefined, 'IFCBOOLEAN', 'IFCLOGICAL', 'IFCLABEL', 'IFCINTEGER']) {
        for (const [vlabel, value] of valueForms) {
          const facet = { type: 'property', propertySet: sv('Probe_Set'), baseName: sv(name), ...(dt ? { dataType: sv(dt) } : {}), value };
          const label = `${schema} ${name} dataType ${dt} value ${vlabel}`;
          const inClass = () => literalsOf(value).some((x) => ONE_ZERO.has(x) && storedBoolean(schema, name, 10) === named(x));
          record('checkPropertyFacet', label, run(() => B.main.ids.checkPropertyFacet(facet, 10, acc.main)), run(() => B.branch.ids.checkPropertyFacet(facet, 10, acc.branch)), inClass);
          record('checkFacet (property)', label, run(() => B.main.ids.checkFacet(facet, 10, acc.main)), run(() => B.branch.ids.checkFacet(facet, 10, acc.branch)), inClass);
          record('propertyFacetPasses (module)', label, run(() => B.main.prop.propertyFacetPasses(facet, 10, acc.main)), run(() => B.branch.prop.propertyFacetPasses(facet, 10, acc.branch)), inClass);
        }
      }
    }
    for (const id of [30, 31, 10]) {
      for (const attr of ['IsMilestone', 'Name', 'Description', 'GlobalId']) {
        for (const [vlabel, value] of valueForms) {
          const facet = { type: 'attribute', name: sv(attr), value };
          const label = `${schema} #${id} ${attr} value ${vlabel}`;
          const inClass = () => attr === 'IsMilestone' && literalsOf(value).some((x) => ONE_ZERO.has(x) && storedBoolean(schema, attr, id) === named(x));
          record('checkAttributeFacet', label, run(() => B.main.ids.checkAttributeFacet(facet, id, acc.main)), run(() => B.branch.ids.checkAttributeFacet(facet, id, acc.branch)), inClass);
        }
      }
    }
  }
}

// ----------------------------------------- public: validateIDS and the audit
const XML_LITERALS = FACET_LITERALS.filter((l) => /^[\x20-\x7E\u00A0-\uFFFF]*$/.test(l));
const x = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const xsv = (v) => `<simpleValue>${x(v)}</simpleValue>`;
const xenum = (vals, base) => `<xs:restriction base="${base}">${vals.map((v) => `<xs:enumeration value="${x(v)}"/>`).join('')}</xs:restriction>`;
const xprop = (name, dt, valueXml, card) => `<property${dt ? ` dataType="${dt}"` : ''}${card ? ` cardinality="${card}"` : ''}><propertySet>${xsv('Probe_Set')}</propertySet><baseName>${xsv(name)}</baseName>${valueXml ? `<value>${valueXml}</value>` : ''}</property>`;
const xattr = (name, valueXml, card) => `<attribute${card ? ` cardinality="${card}"` : ''}><name>${xsv(name)}</name><value>${valueXml}</value></attribute>`;
const xentity = (n) => `<entity><name>${xsv(n)}</name></entity>`;
const named_ = xattr('Name', xsv('Required'));
const xspec = (name, app, req) => `<specification name="${x(name)}" ifcVersion="IFC2X3 IFC4 IFC4X3_ADD2"><applicability minOccurs="0" maxOccurs="unbounded">${app}</applicability><requirements>${req}</requirements></specification>`;
const xids = (specs) => `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema"><info><title>acceptance</title></info><specifications>${specs.join('')}</specifications></ids>`;

function specsFor(l) {
  const specs = [];
  const forms = [['sv', xsv(l)], ['enum xs:boolean', xenum([l], 'xs:boolean')], ['enum xs:string', xenum([l], 'xs:string')], ['enum xs:integer', xenum([l], 'xs:integer')]];
  for (const name of PROP_NAMES) {
    for (const dt of ['', 'IFCBOOLEAN', 'IFCLOGICAL', 'IFCLABEL']) {
      for (const [fl, fx] of forms) {
        for (const card of ['', 'optional', 'prohibited']) {
          specs.push([{ l, name, form: fl, kind: 'requirement' }, xspec(`req|${name}|${dt}|${fl}|${card}`, xentity('IFCWALL'), xprop(name, dt, fx, card))]);
        }
        specs.push([{ l, name, form: fl, kind: 'applicability' }, xspec(`app|${name}|${dt}|${fl}`, xentity('IFCWALL') + xprop(name, dt, fx), named_)]);
      }
    }
  }
  for (const [fl, fx] of forms) {
    for (const card of ['', 'optional', 'prohibited']) {
      specs.push([{ l, name: 'IsMilestone', form: fl, kind: 'requirement' }, xspec(`req|IsMilestone|${fl}|${card}`, xentity('IFCTASK'), xattr('IsMilestone', fx, card))]);
    }
    specs.push([{ l, name: 'IsMilestone', form: fl, kind: 'applicability' }, xspec(`app|IsMilestone|${fl}`, xentity('IFCTASK') + xattr('IsMilestone', fx), named_)]);
  }
  return specs;
}
const verdictOf = (r) => ({
  status: r.status, applicable: r.applicableCount, passed: r.passedCount, failed: r.failedCount, error: r.error,
  rows: r.entityResults.map((e) => [e.expressId, e.passed, e.requirementResults.map((q) => [q.status, q.actualValue, q.expectedValue, q.failureReason, q.failure?.type])]),
});
const SPEC_LITERALS = XML_LITERALS.filter((l) => l.length <= 2 || ['true', 'false', 'TRUE', 'True', 'FALSE', 'False', '.T.', '.F.', '1.0', '0.0', '1e0', '10', '01', '00', '001', '-1', ' true', 'true ', '١', '１', 'UNKNOWN', 'NaN'].includes(l));
// The strict class, per entity: every entity row that changes must hold, for
// the facet's subject, the boolean the literal names.
const rowsOf = (r) => new Map(r.entityResults.map((e) => [e.expressId,
  canon([e.passed, e.requirementResults.map((q) => [q.status, q.actualValue, q.expectedValue, q.failureReason, q.failure?.type])])]));
function storedBoolean(schema, name, id) {
  // IFC Lite reads an IFC2X3 IfcTask attribute at its IFC4 position, so it
  // reads no IsMilestone boolean there (a separate defect).
  if (name === 'IsMilestone') return schema === 'IFC2X3' ? undefined : { 30: true, 31: false }[id];
  return id === 10 ? STORED_BOOLEAN[name]?.[0] : undefined;
}
function inStrictClass(schema, meta, oldResult, newResult) {
  if (!ONE_ZERO.has(meta.l)) return false;
  const a = rowsOf(oldResult);
  const b = rowsOf(newResult);
  const changed = [...new Set([...a.keys(), ...b.keys()])].filter((id) => a.get(id) !== b.get(id));
  return changed.length > 0 && changed.every((id) => storedBoolean(schema, meta.name, id) === named(meta.l));
}
let specCount = 0;
for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3_ADD2']) {
  const store = await parse(model(schema));
  for (let i = 0; i < SPEC_LITERALS.length; i += 8) {
    const chunk = SPEC_LITERALS.slice(i, i + 8).flatMap(specsFor);
    const xml = xids(chunk.map(([, s]) => s));
    const reports = {};
    for (const b of ['main', 'branch']) {
      const doc = B[b].ids.parseIDS(xml);
      const restore = silence();
      try {
        reports[b] = await B[b].ids.validateIDS(doc, B[b].bridge.createDataAccessor(store), { modelId: 'acc', schemaVersion: store.schemaVersion, entityCount: store.entityCount });
      } finally { restore(); }
    }
    chunk.forEach(([meta], k) => {
      specCount++;
      const oldResult = reports.main.specificationResults[k];
      const newResult = reports.branch.specificationResults[k];
      record('validateIDS (per specification)', `${schema} ${oldResult.specification.name} literal ${show(meta.l)}`,
        { ok: canon(verdictOf(oldResult)) }, { ok: canon(verdictOf(newResult)) }, () => inStrictClass(schema, meta, oldResult, newResult));
    });
  }
}

// The audit: every XML literal in every form, as text (auditIDSDocument) and parsed (auditIDSStructure).
const auditOf = (r) => ({ status: r.status, issues: r.issues.map((i) => `${i.severity}:${i.code}:${i.path ?? ''}`).sort() });
for (const l of XML_LITERALS) {
  const xml = xids(specsFor(l).filter(([m]) => m.kind === 'requirement' && ['Flag', 'LabelOne', 'IntOne'].includes(m.name) || m.name === 'IsMilestone').map(([, s]) => s));
  const m = await runAsync(async () => auditOf(await B.main.ids.auditIDSDocument(xml)));
  const br = await runAsync(async () => auditOf(await B.branch.ids.auditIDSDocument(xml)));
  record('auditIDSDocument', `literal ${show(l)}`, m, br, () => false);
  const ms = await runAsync(async () => auditOf(await B.main.ids.auditIDSStructure(B.main.ids.parseIDS(xml))));
  const bs = await runAsync(async () => auditOf(await B.branch.ids.auditIDSStructure(B.branch.ids.parseIDS(xml))));
  record('auditIDSStructure', `literal ${show(l)}`, ms, bs, () => false);
}
// Values that are not strings, put into a parsed document by a JavaScript caller.
const template = xids([
  xspec('enum', xentity('IFCWALL'), xprop('Flag', 'IFCBOOLEAN', xenum(['true'], 'xs:boolean'))),
  xspec('sv', xentity('IFCWALL'), xprop('Flag', 'IFCBOOLEAN', xsv('true'))),
]);
for (const v of NON_STRINGS) {
  const docFor = (b) => {
    const doc = B[b].ids.parseIDS(template);
    doc.specifications[0].requirements[0].facet.value.values = [v];
    doc.specifications[1].requirements[0].facet.value.value = v;
    return doc;
  };
  const m = await runAsync(async () => auditOf(await B.main.ids.auditIDSStructure(docFor('main'))));
  const br = await runAsync(async () => auditOf(await B.branch.ids.auditIDSStructure(docFor('branch'))));
  record('auditIDSStructure (value not a string)', `value ${show(v)}`, m, br, () => false);
}

// ------------------------------------------------------------------ report
console.log(`builds: old = ${OLD}, new = ${NEW}`);
console.log(`inputs: ${LITERALS.length} strings, ${NON_STRINGS.length} values that are not strings, ${XSD_TYPES.length} xsd types, ${ACTUALS.length} stored values, ${specCount} validateIDS specifications`);
console.log('');
console.log('| function | calls | same | changed | of which outside the 1/0 class | old returned, new threw | old threw, new returned | both threw |');
console.log('|---|---|---|---|---|---|---|---|');
for (const [fn, t] of tallies) console.log(`| ${fn} | ${t.calls} | ${t.same} | ${t.changed} | ${t.changedOutsideClass} | ${t.narrowed} | ${t.widened} | ${t.bothThrew} |`);
console.log('');
const k = compareBooleanKinds;
console.log(`compareBoolean's changes: ${k.nowTrue} return true now (the literal names the stored boolean); ${k.undefinedToFalse} went from undefined to false; ${k.other} other.`);
console.log('');
console.log('changed outcomes, first samples per function:');
for (const [fn, s] of changedSamples) { console.log(`- ${fn}`); for (const line of s) console.log(`    ${line}`); }
console.log('');
console.log('threw on both builds, by function and error, with the first inputs:');
for (const [key, { count, examples }] of bothThrew) console.log(`  ${count} x ${key}: ${examples.join(' ; ')}`);
console.log('');
console.log(`outside the class, narrowed, widened or thrown differently (${outside.length}):`);
for (const line of outside) console.log(`  ${line}`);
