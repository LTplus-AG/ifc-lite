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
 * corpus file the problem names. A limit whose fact no longer holds, or that
 * matches no problem of its cell, labels nothing and is reported; `--check`
 * then fails until it is corrected or removed.
 *
 * EXPRESS line numbers: packages/codegen/schemas/IFC2X3_TC1.exp and IFC4_ADD2_TC1.exp.
 */

import { CONSTANT_SUBTYPE, entityName, slotOf } from './probes/convert.mjs';

export const KINDS = ['schema', 'policy', 'upstream'];

/**
 * Whether IFC2X3 holds this IFC4 activity of `step` only as IfcProxy: IFC2X3 lacks the entity, and it is
 * neither a CONST action (CONSTANT_SUBTYPE) nor an action whose representation has an IfcShapeAspect,
 * which StructuralVarying may write as an IFC2X3 varying action.
 */
const proxied = (f, step, act) => Boolean(act) && !f.has('IFC2X3', f.name('IFC4', act.type))
  && !(CONSTANT_SUBTYPE.has(act.type) && (act.args.at(-1)?.enum === 'CONST'
    || step.of('IFCSHAPEASPECT').some((a) => a.args[4]?.ref !== undefined && a.args[4].ref === act.args[6]?.ref)));

/** The source record a `<path>#<id>` problem names. */
const recordOf = (f, m) => f.file(m[1]).get(Number(m[2]));

// The probe lists every distinct non-conformance in the parentheses, so these match only when it is the one named.
const IFC2X3_AXIS = /^(.+): \d+ of \d+ \w+ record\(s\) in the IFC4 file do not conform to IFC4 \(Axis: required value empty\)$/;
const OWNER_HISTORY = /^(.+): \d+ of \d+ \w+ record\(s\) in the IFC2X3 file do not conform to IFC2X3 \(OwnerHistory: required value empty\)$/;
const LOST = /^(.+)#(\d+): lost$/;

const axisSchema = (entity, cite) => ({
  row: `IFC2X3/${entity}`, level: 'convert', kind: 'schema', problem: IFC2X3_AXIS, cite,
  holds: (f, m) => f.required('IFC4', entity, 'Axis') && f.slot('IFC2X3', entity, 'Axis') === null
    && f.file(m[1]).count('IFCRELASSOCIATESPROFILEPROPERTIES') === 0,
});

const reactionSchema = (entity, what) => ({
  row: `IFC4/${entity}`, level: 'convert', kind: 'schema', problem: LOST,
  cite: `IFC2X3 IfcStructuralReaction is ONEOF(IfcStructuralPointReaction) (IFC2X3_TC1.exp:7480): no IFC2X3 entity holds a ${what} reaction`,
  holds: (f, m) => recordOf(f, m)?.type === entity.toUpperCase() && !f.has('IFC2X3', entity),
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
    problem: /^(.+): (\d+) of \d+ IfcRelConnectsStructuralActivity record\(s\) in the IFC2X3 file do not conform to IFC2X3 \(RelatedStructuralActivity: reference to IfcProxy in IfcStructuralActivity\)$/,
    cite: 'IFC2X3 RelatedStructuralActivity : IfcStructuralActivity (IFC2X3_TC1.exp:6610); these relationships name curve and surface reactions and a non-constant curve action, which IFC2X3 can hold only as IfcProxy (their own rows)',
    holds: (f, m) => {
      const step = f.file(m[1]);
      const named = step.of('IFCRELCONNECTSSTRUCTURALACTIVITY').filter((rel) => proxied(f, step, step.get(rel.args[5])));
      return named.length === Number(m[2]);
    },
  },
  {
    row: 'IFC4/IfcRelConnectsStructuralActivity', level: 'convert', kind: 'schema',
    problem: /^(.+)#(\d+): RelatedStructuralActivity "[^"]*", was "[^"]*"$/,
    cite: 'the activity it names came back as another record because IFC2X3 held it only as IfcProxy (same cause as above)',
    holds: (f, m) => {
      const step = f.file(m[1]);
      const rel = step.get(Number(m[2]));
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
    cite: 'IFC2X3 has no IfcStructuralCurveAction (IfcStructuralAction ONEOF, IFC2X3_TC1.exp:7230); its varying action has no PredefinedType (IFC2X3_TC1.exp:7312), so a LINEAR or POLYGONAL action cannot come back as such, and IfcStructuralLoadConfiguration.Locations has no IFC2X3 slot',
    holds: (f, m) => {
      const rec = recordOf(f, m);
      return rec?.type === 'IFCSTRUCTURALCURVEACTION' && !['NOTDEFINED', 'CONST'].includes(rec.args[11]?.enum)
        && !f.has('IFC2X3', 'IfcStructuralCurveAction') && f.slot('IFC2X3', 'IfcStructuralLinearActionVarying', 'PredefinedType') === null;
    },
  },
  {
    row: 'IFC4/IfcStructuralCurveConnection', level: 'convert', kind: 'schema',
    problem: /^(.+)#(\d+): Axis null, was "#IFCDIRECTION"$/,
    cite: 'IFC2X3 IfcStructuralCurveConnection declares no attribute (IFC2X3_TC1.exp:7277) and IFC2X3 gives a connection no orientation, so its Axis (IFC4_ADD2_TC1.exp:9415) cannot be held',
    holds: (f, m) => recordOf(f, m)?.type === 'IFCSTRUCTURALCURVECONNECTION' && f.slot('IFC2X3', 'IfcStructuralCurveConnection', 'Axis') === null,
  },
  ownerHistoryPolicy('IFC4/IfcStructuralCurveMember'),
  reactionSchema('IfcStructuralCurveReaction', 'curve'),
  {
    row: 'IFC4/IfcStructuralLoadConfiguration', level: 'convert', kind: 'schema',
    problem: /^(.+)#(\d+): no IfcStructuralLoadConfiguration with its values came back$/,
    cite: 'IFC2X3 has no IfcStructuralLoadConfiguration; it locates varying loads only by IfcShapeAspect representations (IFC2X3_TC1.exp:7314), so Locations (IFC4_ADD2_TC1.exp:9473) has no IFC2X3 slot',
    holds: (f, m) => {
      const rec = recordOf(f, m);
      return rec?.type === 'IFCSTRUCTURALLOADCONFIGURATION' && Array.isArray(rec.args[2]) && !f.has('IFC2X3', 'IfcStructuralLoadConfiguration');
    },
  },
  ownerHistoryPolicy('IFC4/IfcStructuralSurfaceMember'),
  {
    row: 'IFC4/IfcStructuralSurfaceMemberVarying', level: 'convert', kind: 'schema',
    problem: /^(.+): \d+ of \d+ IfcStructuralSurfaceMemberVarying record\(s\) in the IFC2X3 file do not conform to IFC2X3 \(SubsequentThickness: required value empty, VaryingThicknessLocation: required value empty\)$/,
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
    problem: /^(\d+) of \d+ record\(s\) with a non-zero reaction draw no glyph, e\.g\. (structural\/puntal-alfa\/portal-demo\.ifc)#\d+$/,
    cite: 'puntal-alfa/portal-demo.ifc #161 and #163 have no ObjectPlacement, no Representation and no IfcRelConnectsStructuralActivity, so nothing places them; the exporter should connect each reaction to its point connection',
    holds: (f, m) => {
      const step = f.file(m[2]);
      const connected = new Set(step.of('IFCRELCONNECTSSTRUCTURALACTIVITY').map((rel) => rel.args[5]?.ref));
      const unplaced = step.of('IFCSTRUCTURALPOINTREACTION').filter((r) => r.args[5] === null && r.args[6] === null && !connected.has(r.id));
      return unplaced.length === Number(m[1]) && unplaced.map((r) => r.id).join() === '161,163';
    },
  },
];

/**
 * What a limit's `holds` may ask: the parser's typed registry per schema
 * (`has`, `name`, `slot`, `required`) and a corpus file's parsed STEP (`file`).
 * `slot` is null when the entity has no such attribute; an unknown entity throws.
 */
export function factsOf(ctx) {
  const registry = (schema) => ctx.pkgs.parser.getSchemaRegistryForVersion(schema);
  const slot = (schema, entity, attribute) => {
    if (!entityName(registry(schema), entity.toUpperCase())) throw new Error(`limits: ${schema} has no entity ${entity}`);
    return slotOf(registry(schema), entity.toUpperCase(), attribute);
  };
  return {
    has: (schema, entity) => entity !== undefined && Object.hasOwn(registry(schema).entities, entity),
    name: (schema, keyword) => entityName(registry(schema), keyword),
    slot,
    required: (schema, entity, attribute) => slot(schema, entity, attribute)?.optional === false,
    file(path) {
      const file = ctx.corpus.files.find((x) => x.path === path);
      if (!file) throw new Error(`limits: ${path} is not a corpus file`);
      return file.step;
    },
  };
}

/**
 * Label the problems of each limited cell in `cells` (row id -> level -> cell,
 * from `runProbes`, whose `problems` is the full list the probe reported):
 * `cell.limits = { open, by: [{ kind, cite }] }`, where `open` counts the
 * problems no limit matched. Returns what is wrong with the limits themselves:
 * one that names no probed cell, whose fact does not hold, or that matches no
 * problem (its cell passes, or the probe errored or changed its wording). Such
 * a limit labels nothing; the cell's status and points are untouched either way.
 */
export function markLimits(cells, facts, limits = LIMITS) {
  const issues = [];
  for (const [key, group] of Map.groupBy(limits, (l) => `${l.row} ${l.level}`)) {
    const [row, level] = key.split(' ');
    const cell = cells.get(row)?.[level];
    if (!cell) { issues.push(`${key} is not a probed cell`); continue; }
    const used = new Set();
    const labelled = (problem) => group.filter((l) => {
      const match = l.problem.exec(problem);
      if (!match) return false;
      if (l.holds(facts, match)) { used.add(l); return true; }
      issues.push(`${key} (${l.kind}): the cited fact does not hold for "${problem}"`);
      return false;
    }).length > 0;
    const open = (cell.problems ?? []).filter((p) => !labelled(p)).length;
    const stale = group.filter((l) => !used.has(l));
    if (stale.length) issues.push(`${key} (${stale.map((l) => l.kind).join(', ')}) labels no problem the probe reported (${cell.status}${cell.problems ? '' : ', no problem list'})`);
    if (used.size) cell.limits = { open, by: [...used].map(({ kind, cite }) => ({ kind, cite })) };
  }
  return issues;
}
