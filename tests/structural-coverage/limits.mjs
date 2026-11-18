/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Limits: problems a probe reports that no product change can fix, because an
 * IFC schema has no slot or entity for the value (`schema`), a project policy
 * forbids the only fix (`policy`), or the fixture's exporter wrote a record the
 * product cannot place (`upstream`).
 *
 * A limit never changes a status or a score. It labels a problem the probe
 * reported, and `markLimits` puts the labels on the cell. A cell is out of
 * reach only when every one of its problems carries a label; the ledger shows
 * which cells that leaves reachable.
 *
 * Each limit names its row and level, matches whole problem strings with
 * `problem`, cites the schema slot, policy or record, and `holds(facts, match)`
 * re-checks that fact against the parser's typed schema registries and the
 * corpus file the problem names. A limit whose fact does not hold, or that
 * matches no problem of its cell, is reported, and the run exits 1 until it
 * is corrected or removed.
 *
 * EXPRESS line numbers: packages/codegen/schemas/IFC2X3_TC1.exp and IFC4_ADD2_TC1.exp.
 */

import { SCHEMAS } from './catalogue.mjs';
import { CONSTANT_SUBTYPE, entityName, slotOf } from './probes/convert.mjs';

/** Limit kinds and how the ledger names a cell every problem of which carries that kind. */
export const KINDS = { schema: 'out of reach (schema)', policy: 'policy-limited', upstream: 'upstream' };

/** An activity's PredefinedType, its last attribute. */
const predefinedOf = (act) => act.args.at(-1);

/**
 * Whether IFC2X3 holds this IFC4 activity of `step` only as IfcProxy: IFC2X3 lacks the entity, and it is
 * neither a CONST action (CONSTANT_SUBTYPE) nor an action whose representation has one IfcShapeAspect
 * with a representation per load of its configuration, which StructuralVarying writes as an IFC2X3 varying action.
 */
function proxied(f, step, act) {
  const name = act && f.name('IFC4', act.type);
  if (!name || f.has('IFC2X3', name)) return false;
  if (!CONSTANT_SUBTYPE.has(act.type)) return true;
  // An empty PredefinedType may come back CONST, as the convert probe allows.
  const predefined = predefinedOf(act);
  if (predefined === null || predefined?.enum === 'CONST') return false;
  const shape = act.args[6]?.ref;
  const aspects = shape === undefined ? [] : step.of('IFCSHAPEASPECT').filter((a) => a.args[4]?.ref === shape);
  const values = step.get(act.args[7])?.args[1];
  return !(aspects.length === 1 && Array.isArray(values) && aspects[0].args[0]?.length === values.length);
}

/** IFC4 activities that can apply a load configuration. */
const ACTIVITIES = ['IFCSTRUCTURALCURVEACTION', 'IFCSTRUCTURALSURFACEACTION', 'IFCSTRUCTURALCURVEREACTION', 'IFCSTRUCTURALSURFACEREACTION'];

/** The source record a `<path>#<id>` problem names. */
const recordOf = (f, m) => f.file(m[1]).get(Number(m[2]));

/**
 * A convert problem for records of a file that do not conform to the other schema with exactly `why`
 * (the probe lists every distinct reason, then the ids): m[1] is the path, m[2] the count, m[3] the ids.
 */
const nonConformingOnly = (entity, schema, why) => new RegExp(`^(.+): (\\d+) of \\d+ ${entity} record\\(s\\) in the ${schema} file do not conform to ${schema} \\(${why} at (#\\d+(?:, #\\d+)*)\\)$`);
const idsOf = (m) => m[3].split(', ').map((id) => Number(id.slice(1)));
const IFC2X3_AXIS = nonConformingOnly('\\w+', 'IFC4', 'Axis: required value empty');
const OWNER_HISTORY = nonConformingOnly('\\w+', 'IFC2X3', 'OwnerHistory: required value empty');
const LOST = /^(.+)#(\d+): lost$/;

const axisSchema = (entity, cite) => ({
  row: `IFC2X3/${entity}`, level: 'convert', kind: 'schema', problem: IFC2X3_AXIS, cite,
  holds: (f, m) => {
    const step = f.file(m[1]);
    // No profile orientation names any of these records (IfcRelAssociates.RelatedObjects).
    const oriented = new Set(step.of('IFCRELASSOCIATESPROFILEPROPERTIES').flatMap((rel) => (rel.args[4] ?? []).map((r) => r.ref)));
    return f.required('IFC4', entity, 'Axis') && f.slot('IFC2X3', entity, 'Axis') === null
      && idsOf(m).every((id) => step.get(id)?.type === entity.toUpperCase() && !oriented.has(id));
  },
});

const reactionSchema = (entity, what) => ({
  row: `IFC4/${entity}`, level: 'convert', kind: 'schema', problem: LOST,
  cite: `IFC2X3 IfcStructuralReaction is ONEOF(IfcStructuralPointReaction) (IFC2X3_TC1.exp:7480): no IFC2X3 entity holds a ${what} reaction`,
  holds: (f, m) => recordOf(f, m)?.type === entity.toUpperCase() && !f.has('IFC2X3', entity),
});

/**
 * IFC2X3 can hold an IFC4 curve member's Axis only as IfcRelAssociatesProfileProperties.ProfileOrientation,
 * whose RelatingProfileProperties is required. With no profile properties in the source, writing it means
 * pointing a required reference at a record made up for it (#10597).
 */
const axisPolicy = (entity) => ({
  row: `IFC4/${entity}`, level: 'convert', kind: 'policy', problem: /^(.+)#(\d+): Axis null, was "#IFCDIRECTION"$/,
  cite: 'IFC2X3 has no Axis (IFC2X3_TC1.exp:7281); its only slot is IfcRelAssociatesProfileProperties.ProfileOrientation (IFC2X3_TC1.exp:6548), whose RelatingProfileProperties is required. The source has no IfcProfileProperties, and the downgrade never points a required entity reference at a record it makes up (Ifc2x3SlotFill, #4714; #10597)',
  holds: (f, m) => recordOf(f, m)?.type === entity.toUpperCase() && f.slot('IFC2X3', entity, 'Axis') === null
    && f.required('IFC2X3', 'IfcRelAssociatesProfileProperties', 'RelatingProfileProperties')
    && f.file(m[1]).count('IFCPROFILEPROPERTIES') === 0 && f.file(m[1]).count('IFCGENERALPROFILEPROPERTIES') === 0,
});

const ownerHistoryPolicy = (row) => ({
  row, level: 'convert', kind: 'policy', problem: OWNER_HISTORY,
  cite: 'IfcRoot.OwnerHistory is OPTIONAL in IFC4 (IFC4_ADD2_TC1.exp:8891) and required in IFC2X3 (IFC2X3_TC1.exp:6905); the source has no IfcOwnerHistory, and the downgrade never invents one (#4686)',
  holds: (f, m) => !f.required('IFC4', 'IfcRoot', 'OwnerHistory') && f.required('IFC2X3', 'IfcRoot', 'OwnerHistory')
    && f.file(m[1]).count('IFCOWNERHISTORY') === 0,
});

export const LIMITS = [
  axisSchema('IfcStructuralCurveConnection', 'IFC4 IfcStructuralCurveConnection.Axis : IfcDirection is required (IFC4_ADD2_TC1.exp:9415); the IFC2X3 entity declares no attribute (IFC2X3_TC1.exp:7277) and IFC2X3 gives a connection no orientation, so filling Axis would invent it'),
  axisSchema('IfcStructuralCurveMember', 'IFC4 IfcStructuralCurveMember.Axis is required (IFC4_ADD2_TC1.exp:9423) and IFC2X3 has no Axis (IFC2X3_TC1.exp:7281); the upgrade fills it from IfcRelAssociatesProfileProperties.ProfileOrientation (IFC2X3_TC1.exp:6548), which this source does not have, so filling it would invent it'),
  axisSchema('IfcStructuralCurveMemberVarying', 'as IfcStructuralCurveMember: IFC4 requires the inherited Axis (IFC4_ADD2_TC1.exp:9423); the source has no profile orientation to fill it from'),
  {
    row: 'IFC4/IfcRelConnectsStructuralActivity', level: 'convert', kind: 'schema',
    problem: nonConformingOnly('IfcRelConnectsStructuralActivity', 'IFC2X3', 'RelatedStructuralActivity: reference to IfcProxy in IfcStructuralActivity'),
    cite: 'IFC2X3 RelatedStructuralActivity : IfcStructuralActivity (IFC2X3_TC1.exp:6610); these relationships name curve and surface reactions and a non-constant curve action, which IFC2X3 can hold only as IfcProxy (their own rows)',
    holds: (f, m) => {
      const step = f.file(m[1]);
      const named = step.of('IFCRELCONNECTSSTRUCTURALACTIVITY').filter((rel) => proxied(f, step, step.get(rel.args[5])));
      return named.map((rel) => rel.id).join() === idsOf(m).join();
    },
  },
  {
    row: 'IFC4/IfcRelConnectsStructuralActivity', level: 'convert', kind: 'schema',
    problem: /^(.+)#(\d+): RelatedStructuralActivity "[^"]*", was "[^"]*"$/,
    cite: 'the activity it names came back as another record because IFC2X3 held it only as IfcProxy (same cause as above)',
    holds: (f, m) => {
      const step = f.file(m[1]);
      const rel = recordOf(f, m);
      return rel?.type === 'IFCRELCONNECTSSTRUCTURALACTIVITY' && proxied(f, step, step.get(rel.args[5]));
    },
  },
  {
    row: 'IFC4/IfcStructuralAnalysisModel', level: 'convert', kind: 'schema',
    problem: /^(.+)#(\d+): SharedPlacement "#IFCLOCALPLACEMENT", was null$/,
    cite: 'IFC2X3 IfcStructuralAnalysisModel has no SharedPlacement (IFC2X3_TC1.exp:7251); a source that left it empty and one that set it to the placement its items share give the same IFC2X3 file, and IFC4 informal proposition 1 says it is provided when items are grouped',
    holds: (f, m) => recordOf(f, m)?.args[9] === null && f.slot('IFC4', 'IfcStructuralAnalysisModel', 'SharedPlacement')?.optional === true
      && f.slot('IFC2X3', 'IfcStructuralAnalysisModel', 'SharedPlacement') === null,
  },
  {
    row: 'IFC4/IfcStructuralCurveAction', level: 'convert', kind: 'schema', problem: LOST,
    cite: 'IFC2X3 has no IfcStructuralCurveAction (IfcStructuralAction ONEOF, IFC2X3_TC1.exp:7230); its varying action has no PredefinedType (IFC2X3_TC1.exp:7312), so a LINEAR or POLYGONAL action cannot come back as such',
    holds: (f, m) => {
      const rec = recordOf(f, m);
      return rec?.type === 'IFCSTRUCTURALCURVEACTION' && !['NOTDEFINED', 'CONST'].includes(predefinedOf(rec)?.enum)
        && !f.has('IFC2X3', 'IfcStructuralCurveAction') && f.required('IFC4', 'IfcStructuralCurveAction', 'PredefinedType')
        && !f.attributes('IFC2X3', 'IfcStructuralLinearActionVarying').includes('PredefinedType');
    },
  },
  {
    row: 'IFC4/IfcStructuralCurveConnection', level: 'convert', kind: 'schema',
    problem: /^(.+)#(\d+): Axis null, was "#IFCDIRECTION"$/,
    cite: 'IFC2X3 IfcStructuralCurveConnection declares no attribute (IFC2X3_TC1.exp:7277) and IFC2X3 gives a connection no orientation, so its Axis (IFC4_ADD2_TC1.exp:9415) cannot be held',
    holds: (f, m) => recordOf(f, m)?.type === 'IFCSTRUCTURALCURVECONNECTION' && f.slot('IFC2X3', 'IfcStructuralCurveConnection', 'Axis') === null,
  },
  ownerHistoryPolicy('IFC4/IfcStructuralCurveMember'),
  axisPolicy('IfcStructuralCurveMember'),
  axisPolicy('IfcStructuralCurveMemberVarying'),
  reactionSchema('IfcStructuralCurveReaction', 'curve'),
  {
    row: 'IFC4/IfcStructuralLoadConfiguration', level: 'convert', kind: 'schema',
    problem: /^(.+)#(\d+): no IfcStructuralLoadConfiguration with its values came back$/,
    cite: 'IFC2X3 has no IfcStructuralLoadConfiguration (IFC4_ADD2_TC1.exp:9470); it holds the loads only on a varying action, located by point representations of that action\'s own shape (IFC2X3_TC1.exp:7314). Each of these configurations has a Name, which nothing in IFC2X3 holds, or is applied by an action with no shape or by a curve reaction, which IFC2X3 lacks',
    holds: (f, m) => {
      const step = f.file(m[1]);
      const rec = recordOf(f, m);
      if (rec?.type !== 'IFCSTRUCTURALLOADCONFIGURATION' || f.has('IFC2X3', 'IfcStructuralLoadConfiguration')) return false;
      const named = rec.args[0] !== null;
      // An activity that applies it (AppliedLoad) and that IFC2X3 cannot hold with a location: no shape, or a reaction it lacks.
      const users = ACTIVITIES.flatMap((t) => step.of(t)).filter((a) => a.args[7]?.ref === rec.id);
      const unlocatable = (a) => a.args[6] === null || (/REACTION$/.test(a.type) && !f.has('IFC2X3', f.name('IFC4', a.type)));
      return named || (users.length > 0 && users.every(unlocatable));
    },
  },
  ownerHistoryPolicy('IFC4/IfcStructuralSurfaceMember'),
  {
    row: 'IFC4/IfcStructuralSurfaceMemberVarying', level: 'convert', kind: 'schema',
    problem: nonConformingOnly('IfcStructuralSurfaceMemberVarying', 'IFC2X3', 'SubsequentThickness: required value empty, VaryingThicknessLocation: required value empty'),
    cite: 'IFC2X3 requires SubsequentThickness LIST [2:?] and VaryingThicknessLocation (IFC2X3_TC1.exp:7522, :7523), which IFC4 does not have (IFC4_ADD2_TC1.exp:9652); the source gives no Pset_StructuralSurfaceMemberVaryingThickness, so filling them would invent thicknesses',
    holds: (f, m) => f.required('IFC2X3', 'IfcStructuralSurfaceMemberVarying', 'SubsequentThickness')
      && f.slot('IFC4', 'IfcStructuralSurfaceMemberVarying', 'SubsequentThickness') === null
      && !f.file(m[1]).of('IFCPROPERTYSET').some((set) => set.args[2] === 'Pset_StructuralSurfaceMemberVaryingThickness'),
  },
  reactionSchema('IfcStructuralSurfaceReaction', 'surface'),
  {
    row: 'IFC4/IfcSurfaceReinforcementArea', level: 'convert', kind: 'schema',
    problem: /^(.+): IFC4 -> IFC2X3 -> IFC4 threw: Cannot convert #\d+=IFCSURFACEREINFORCEMENTAREA\(/,
    cite: 'IFC2X3 has no IfcSurfaceReinforcementArea (IFC4_ADD2_TC1.exp:9769) and it is no IfcRoot, so it cannot become an IfcProxy; the converter refuses the file',
    holds: (f) => !f.has('IFC2X3', 'IfcSurfaceReinforcementArea'),
  },
  {
    row: 'IFC4X3/IfcStructuralPointReaction', level: 'render', kind: 'upstream',
    problem: /^2 of \d+ record\(s\) with a non-zero reaction draw no glyph: (structural\/puntal-alfa\/portal-demo\.ifc)#161, \1#163$/,
    cite: 'puntal-alfa/portal-demo.ifc #161 and #163 have no ObjectPlacement, no Representation and no IfcRelConnectsStructuralActivity, so nothing places them; the exporter should connect each reaction to its point connection',
    holds: (f, m) => {
      const step = f.file(m[1]);
      const connected = new Set(step.of('IFCRELCONNECTSSTRUCTURALACTIVITY').map((rel) => rel.args[5]?.ref));
      const unplaced = step.of('IFCSTRUCTURALPOINTREACTION').filter((r) => r.args[5] === null && r.args[6] === null && !connected.has(r.id));
      return unplaced.map((r) => r.id).join() === '161,163';
    },
  },
];

/**
 * What a limit's `holds` may ask: the parser's typed registry per schema
 * (`has`, `name`, `slot`, `attributes`, `required`) and a corpus file's parsed STEP (`file`).
 * `slot` is null when the entity has no such attribute. A name no schema
 * knows throws, so a typo cannot pass as "IFC2X3 lacks it": an entity must
 * exist in some catalogue schema, and an attribute on that entity in one.
 */
export function factsOf(ctx) {
  const registry = (schema) => ctx.pkgs.parser.getSchemaRegistryForVersion(schema);
  const known = (entity) => {
    const found = SCHEMAS.map((s) => registry(s).entities[entity]).filter(Boolean);
    if (!found.length) throw new Error(`limits: no schema has an entity ${entity}`);
    return found;
  };
  const slot = (schema, entity, attribute) => {
    if (!known(entity).some((e) => e.allAttributes.some((a) => a.name === attribute))) throw new Error(`limits: no schema gives ${entity} an attribute ${attribute}`);
    if (!entityName(registry(schema), entity.toUpperCase())) throw new Error(`limits: ${schema} has no entity ${entity}`);
    return slotOf(registry(schema), entity.toUpperCase(), attribute);
  };
  return {
    has(schema, entity) {
      known(entity);
      return Object.hasOwn(registry(schema).entities, entity);
    },
    name: (schema, keyword) => entityName(registry(schema), keyword),
    slot,
    attributes(schema, entity) {
      known(entity);
      return registry(schema).entities[entity]?.allAttributes.map((x) => x.name) ?? [];
    },
    required: (schema, entity, attribute) => slot(schema, entity, attribute)?.optional === false,
    file(path) {
      const file = ctx.corpus.files.find((x) => x.path === path);
      if (!file) throw new Error(`limits: ${path} is not a corpus file`);
      return file.step;
    },
  };
}

/** A limit's `holds`, or the error it threw. */
function holds(limit, facts, match) {
  try { return limit.holds(facts, match); } catch (e) { return e; }
}

/**
 * Label the problems of each limited cell in `cells` (row id -> level -> cell,
 * from `runProbes`, whose `problems` is the full list the probe reported):
 * `cell.limits = { open, by: [{ kind, cite }] }`, where `open` counts the
 * problems no limit matched. Returns what is wrong with the limits themselves:
 * one that names no probed cell, whose fact does not hold for a problem it
 * matches (that problem stays open), or that matches no problem (its cell
 * passes, or the probe errored or changed its wording). The cell's status and
 * points are untouched either way.
 */
export function markLimits(cells, facts, limits = LIMITS) {
  const issues = [];
  for (const [key, group] of Map.groupBy(limits, (l) => `${l.row} ${l.level}`)) {
    const [row, level] = key.split(' ');
    const cell = cells.get(row)?.[level];
    if (!cell) { issues.push(`${key} is not a probed cell`); continue; }
    const used = new Set();
    const matched = new Set();
    const labelled = (problem) => group.filter((l) => {
      const match = l.problem.exec(problem);
      if (!match) return false;
      matched.add(l);
      const held = holds(l, facts, match);
      if (held === true) { used.add(l); return true; }
      issues.push(`${key} (${l.kind}): the cited fact does not hold for "${problem}"${held instanceof Error ? ` (${held.message})` : ''}`);
      return false;
    }).length > 0;
    const open = (cell.problems ?? []).filter((p) => !labelled(p)).length;
    const stale = group.filter((l) => !matched.has(l));
    if (stale.length) issues.push(`${key} (${stale.map((l) => l.kind).join(', ')}) labels no problem the probe reported (${cell.status}${cell.problems ? '' : ', no problem list'})`);
    if (used.size) cell.limits = { open, by: [...used].map(({ kind, cite }) => ({ kind, cite })) };
  }
  return issues;
}
