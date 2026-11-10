/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Level `read`: `extractStructuralOnDemand` (packages/parser) returns the
 * entity with the values the file holds.
 *
 * For every sampled record of the row's entity in a corpus file of the row's
 * schema, each of the entity's own attributes (those below IfcProduct /
 * IfcGroup / IfcRelConnects, plus Name and GlobalId) that the file sets is
 * compared with the read model's field for it. Pass needs every record found
 * and every value equal. A value the read model has no field for is reported
 * as unexposed and makes the row partial, so a found-but-hollow read never
 * passes. Relationships pass when both ends carry the link.
 */

import { parseStore } from '../lib/packages.mjs';
import { equal, normalize, show, typeIndex, verdict } from '../lib/values.mjs';

const NO_FIELD = Symbol('no field');
const MAX_FILES = 3;
const MAX_RECORDS = 25;

const ref = (x) => (x ? `#${x.expressId}` : null);
const ROOT_FIELDS = { GlobalId: (i) => i.globalId, Name: (i) => i.name ?? null, Description: (i) => i.description ?? null, ObjectType: (i) => i.objectType ?? null, PredefinedType: (i) => i.predefinedType ?? null };

const FIELDS = {
  item: { ...ROOT_FIELDS, Thickness: (i) => i.thickness ?? null, AppliedCondition: (i) => ref(i.appliedCondition) },
  activity: { ...ROOT_FIELDS, AppliedLoad: (i) => ref(i.appliedLoad), GlobalOrLocal: (i) => i.globalOrLocal ?? null, DestabilizingLoad: (i) => i.destabilizingLoad ?? null },
  group: {
    ...ROOT_FIELDS,
    ActionType: (i) => i.actionType ?? null,
    ActionSource: (i) => i.actionSource ?? null,
    Coefficient: (i) => i.coefficient ?? null,
    Purpose: (i) => i.purpose ?? null,
    SelfWeightCoefficients: (i) => i.selfWeightCoefficients ?? null,
    TheoryType: (i) => i.theoryType ?? null,
    ResultForLoadGroup: (i) => i.resultForLoadGroupGlobalId ?? null,
    IsLinear: (i) => i.isLinear ?? null,
    LoadedBy: (i) => i.loadGroupGlobalIds,
    HasResults: (i) => i.resultGroupGlobalIds,
  },
};

function resourceField(info, attr) {
  if (attr === 'Name') return info.name ?? null;
  if (info.configuration && attr === 'Values') return info.configuration.entries.map((e) => ref(e.value));
  if (info.configuration && attr === 'Locations') return info.configuration.entries.map((e) => e.location ?? []);
  return info.components?.[attr];
}

/** Relationship end attributes and how the read model is expected to carry the link. */
const LINKS = {
  IfcRelConnectsStructuralMember: ['RelatingStructuralMember', 'RelatedStructuralConnection', (ix, a, b) => ix.byGuid.get(a)?.connectionGlobalIds?.includes(b) && ix.byGuid.get(b)?.memberGlobalIds?.includes(a)],
  IfcRelConnectsWithEccentricity: ['RelatingStructuralMember', 'RelatedStructuralConnection', (ix, a, b) => ix.byGuid.get(a)?.connectionGlobalIds?.includes(b) && ix.byGuid.get(b)?.memberGlobalIds?.includes(a)],
  IfcRelConnectsStructuralActivity: ['RelatingElement', 'RelatedStructuralActivity', (ix, a, b) => ix.byGuid.get(b)?.appliesToGlobalId === a],
  // IFC2X3 only: a physical element to its structural member. The read model has no field for it yet.
  IfcRelConnectsStructuralElement: ['RelatingElement', 'RelatedStructuralMember', () => false],
};

/** Every read-model object of the extraction, by expressId and GlobalId. */
function indexExtraction(x) {
  const byId = new Map();
  const byGuid = new Map();
  // Result groups and analysis models carry no `type` field: their collection names it.
  const put = (family, info, type = info.type) => { byId.set(info.expressId, { family, info, type }); if (info.globalId) byGuid.set(info.globalId, info); };
  for (const m of x.members) put('item', m);
  for (const c of x.connections) put('item', c);
  for (const a of x.activities) put('activity', a);
  for (const g of x.loadGroups) put('group', g);
  for (const g of x.resultGroups) put('group', g, 'IfcStructuralResultGroup');
  for (const g of x.analysisModels) put('group', g, 'IfcStructuralAnalysisModel');
  const loads = (l) => { if (!l || byId.has(l.expressId)) return; put('resource', l); for (const e of l.configuration?.entries ?? []) loads(e.value); };
  for (const a of x.activities) loads(a.appliedLoad);
  for (const c of x.connections) if (c.appliedCondition) put('resource', c.appliedCondition);
  return { byId, byGuid };
}

async function extraction(ctx, file) {
  const key = `read:${file.path}`;
  if (!ctx.cache.has(key)) {
    ctx.cache.set(key, (async () => {
      const store = await parseStore(ctx.pkgs, file.bytes);
      return indexExtraction(ctx.pkgs.parser.extractStructuralOnDemand(store));
    })());
  }
  return ctx.cache.get(key);
}

function checkRecord(row, record, file, ix, types) {
  const problems = [];
  const where = `${file.path}#${record.id}`;
  const value = (attr) => normalize(record.args[row.attributes.indexOf(attr)], file.step, types);
  const link = LINKS[row.entity];
  if (link) {
    const [from, to, held] = link;
    const ok = held(ix, value(from), value(to));
    if (!ok) problems.push(`${where}: link ${from} -> ${to} not in the read model`);
    for (const attr of row.own.filter((a) => a !== from && a !== to && a !== 'Name')) {
      if (value(attr) !== null) problems.push(`${where}: ${attr} unexposed`);
    }
    return { problems, held: ok };
  }
  const hit = ix.byId.get(record.id);
  if (!hit || hit.type !== row.entity) {
    return { problems: [`${where}: not in the read model${hit ? ` (read as ${hit.type})` : ''}`], held: false };
  }
  const attrs = row.rooted ? ['GlobalId', ...row.own] : row.own;
  for (const attr of attrs) {
    const want = value(attr);
    if (want === null) continue;
    const getter = row.family === 'resource' ? (i) => resourceField(i, attr) : FIELDS[row.family]?.[attr] ?? (() => NO_FIELD);
    const got = getter(hit.info);
    if (got === NO_FIELD) problems.push(`${where}: ${attr} unexposed`);
    else if (!equal(want, got ?? null)) problems.push(`${where}: ${attr} ${show(got)}, file ${show(want)}`);
  }
  return { problems, held: true };
}

export default {
  name: 'read:extractStructuralOnDemand',
  level: 'read',
  async run(rows, ctx) {
    const out = new Map();
    for (const row of rows) {
      const carriers = ctx.corpus.carriers(row.schema, row.entity).slice(0, MAX_FILES);
      if (!carriers.length) { out.set(row.id, ctx.corpus.nothingCarries(row.schema, row.entity)); continue; }
      const types = typeIndex(ctx.tables[row.schema]);
      const problems = [];
      let checked = 0;
      let anyHeld = false;
      for (const file of carriers) {
        let ix;
        try {
          ix = await extraction(ctx, file);
        } catch (e) {
          problems.push(`${file.path}: parse or extract threw: ${e.message}`);
          continue;
        }
        for (const record of file.step.of(row.entity).slice(0, MAX_RECORDS)) {
          checked++;
          const r = checkRecord(row, record, file, ix, types);
          problems.push(...r.problems);
          anyHeld ||= r.held;
        }
      }
      out.set(row.id, { ...verdict(checked, problems, { anyHeld }), evidence: carriers.map((f) => f.path) });
    }
    return out;
  },
};
