/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Level `read`: `extractStructuralOnDemand` (packages/parser) returns the
 * entity with the values the file holds.
 *
 * Every record of the row's entity in every corpus file of the row's schema is
 * checked (no sampling). For each of the entity's own attributes (those below
 * IfcProduct / IfcGroup / IfcRelConnects, plus Name and GlobalId): every record
 * that sets it must be read with that value; an attribute no fixture sets at all
 * is unproven. Pass needs every record found, every attribute set somewhere,
 * and every value equal. A value the read model has no field for is unexposed.
 * Relationships pass when both ends carry the link. See `readRow`.
 */

import { cached, storeOf } from '../lib/packages.mjs';
import { equal, normalize, show, verdict } from '../lib/values.mjs';

const NO_FIELD = Symbol('no field');

/**
 * The read model names a field after its EXPRESS attribute in camelCase
 * (`GlobalOrLocal` -> `globalOrLocal`). These three resolve to GlobalIds and
 * are named for that instead.
 */
const RENAMED = { LoadedBy: 'loadGroupGlobalIds', HasResults: 'resultGroupGlobalIds', ResultForLoadGroup: 'resultForLoadGroupGlobalId' };
const ref = (x) => (x ? `#${x.expressId}` : null);

/** A rooted object's field for `attr`, NO_FIELD when no read-model object of its type has that field. */
function rootedField(ix, type, info, attr) {
  const key = RENAMED[attr] ?? attr[0].toLowerCase() + attr.slice(1);
  if (!ix.fields.get(type)?.has(key)) return NO_FIELD;
  const v = info[key];
  return v && typeof v === 'object' && !Array.isArray(v) && 'expressId' in v ? ref(v) : v;
}

function resourceField(info, attr) {
  if (attr === 'Name') return info.name;
  if (info.configuration && attr === 'Values') return info.configuration.entries.map((e) => ref(e.value));
  if (info.configuration && attr === 'Locations') return info.configuration.entries.map((e) => e.location ?? []);
  return info.components?.[attr];
}

/** Relationship end attributes and how the read model is expected to carry the link, by catalogue root. */
const LINKS = {
  IfcRelConnectsStructuralMember: ['RelatingStructuralMember', 'RelatedStructuralConnection', (ix, a, b) => ix.byGuid.get(a)?.connectionGlobalIds?.includes(b) && ix.byGuid.get(b)?.memberGlobalIds?.includes(a)],
  IfcRelConnectsStructuralActivity: ['RelatingElement', 'RelatedStructuralActivity', (ix, a, b) => ix.byGuid.get(b)?.appliesToGlobalId === a],
  // IFC2X3 only: a physical element to its structural member. The read model has no field for it yet.
  IfcRelConnectsStructuralElement: ['RelatingElement', 'RelatedStructuralMember', () => false],
};

/** Every read-model object of the extraction, by expressId and GlobalId, plus the fields each type has. */
function indexExtraction(x) {
  const byId = new Map();
  const byGuid = new Map();
  const fields = new Map();
  // Result groups and analysis models carry no `type` field: their collection names it.
  const put = (family, info, type = info.type) => {
    byId.set(info.expressId, { family, info, type });
    if (info.globalId) byGuid.set(info.globalId, info);
    if (!fields.has(type)) fields.set(type, new Set());
    for (const k of Object.keys(info)) fields.get(type).add(k);
  };
  for (const m of x.members) put('item', m);
  for (const c of x.connections) put('item', c);
  for (const a of x.activities) put('activity', a);
  for (const g of x.loadGroups) put('group', g);
  for (const g of x.resultGroups) put('group', g, 'IfcStructuralResultGroup');
  for (const g of x.analysisModels) put('group', g, 'IfcStructuralAnalysisModel');
  const loads = (l) => { if (!l || byId.has(l.expressId)) return; put('resource', l); for (const e of l.configuration?.entries ?? []) loads(e.value); };
  for (const a of x.activities) loads(a.appliedLoad);
  for (const c of x.connections) if (c.appliedCondition) put('resource', c.appliedCondition);
  return { byId, byGuid, fields };
}

/** The indexed read model of one corpus file, shared by every probe that reads it. */
export function extraction(ctx, file) {
  return cached(ctx, `read:${file.path}`, async () => indexExtraction(ctx.pkgs.parser.extractStructuralOnDemand(await storeOf(ctx, file))));
}

/**
 * `extraction`, or null after recording why: a file the product cannot parse or
 * extract is a measured problem for the row, never a probe error that hides the
 * other files' results.
 */
export async function extractionOrProblem(ctx, file, problems) {
  try {
    return await extraction(ctx, file);
  } catch (e) {
    problems.push(`${file.path}: parse or extract threw: ${e.message}`);
    return null;
  }
}

/**
 * The read verdict for one row over every record of its entity in `entries`
 * (`{ file, ix }`, `ix` null when the file did not extract). Pure, and
 * independent of file order: each attribute is judged over all the records
 * that set it, so an attribute set in any carrier file must be read with that
 * value, and one no fixture sets at all is unproven, which keeps the cell
 * below a full pass until a fixture carries it.
 */
export function readRow(row, entries, types, problems = []) {
  const ordered = [...entries].sort((a, b) => a.file.sha256.localeCompare(b.file.sha256) || a.file.path.localeCompare(b.file.path));
  // A file that did not extract is already a problem; its records prove nothing either way.
  const records = ordered.filter((e) => e.ix).flatMap(({ file, ix }) => file.step.of(row.entity).map((rec) => ({ file, ix, rec, where: `${file.path}#${rec.id}` })));
  if (!records.length) return { status: 'fail', reason: problems.join('; ') || 'no record was checked' };
  const value = (r, attr) => normalize(r.rec.args[row.attributes.indexOf(attr)], r.file.step, types);
  const out = [...problems];
  const link = LINKS[row.root];
  const [from, to, held] = link ?? [];
  const found = new Set(records.filter((r) => (link ? held(r.ix, value(r, from), value(r, to)) : r.ix.byId.get(r.rec.id)?.type === row.entity)));
  const lost = records.filter((r) => !found.has(r));
  if (lost.length) {
    const hit = lost[0].ix.byId.get(lost[0].rec.id);
    out.push(link
      ? `link ${from} -> ${to} not in the read model for ${lost.length} of ${records.length} record(s), e.g. ${lost[0].where}`
      : `${lost.length} of ${records.length} record(s) not in the read model, e.g. ${lost[0].where}${hit ? ` (read as ${hit.type})` : ''}`);
  }
  const attrs = link ? row.own.filter((a) => a !== from && a !== to && a !== 'Name') : row.rooted ? ['GlobalId', ...row.own] : row.own;
  for (const attr of attrs) {
    const setters = records.filter((r) => value(r, attr) !== null);
    if (!setters.length) { out.push(`${attr}: no fixture sets it, so reading it is unproven`); continue; }
    if (link) { out.push(`${attr} unexposed (set in ${setters.length} record(s))`); continue; }
    const read = setters.filter((r) => found.has(r));
    if (!read.length) continue; // its records are already reported as not in the read model
    const field = (r) => {
      const hit = r.ix.byId.get(r.rec.id);
      return row.family === 'resource' ? resourceField(hit.info, attr) : rootedField(r.ix, hit.type, hit.info, attr);
    };
    if (read.every((r) => field(r) === NO_FIELD)) { out.push(`${attr} unexposed (set in ${setters.length} record(s))`); continue; }
    const wrong = read.filter((r) => { const got = field(r); return got === NO_FIELD || !equal(value(r, attr), got ?? null); });
    if (wrong.length) {
      const got = field(wrong[0]);
      out.push(`${attr} wrong in ${wrong.length} of ${read.length} record(s), e.g. ${wrong[0].where}: ${got === NO_FIELD ? 'unexposed' : show(got ?? null)}, file ${show(value(wrong[0], attr))}`);
    }
  }
  return verdict(records.length, out, { anyHeld: found.size > 0 });
}

export default {
  name: 'read:extractStructuralOnDemand',
  level: 'read',
  async run(rows, ctx) {
    const out = new Map();
    for (const row of rows) {
      const carriers = ctx.corpus.carriers(row.schema, row.entity);
      if (!carriers.length) { out.set(row.id, ctx.corpus.nothingCarries(row.schema, row.entity)); continue; }
      const problems = [];
      const entries = [];
      for (const file of carriers) entries.push({ file, ix: await extractionOrProblem(ctx, file, problems) });
      out.set(row.id, { ...readRow(row, entries, ctx.tables[row.schema].types, problems), evidence: carriers.map((f) => f.path) });
    }
    return out;
  },
};
