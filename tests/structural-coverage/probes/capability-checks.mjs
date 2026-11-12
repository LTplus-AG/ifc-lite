/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Probes for three of the analytical model checks: `structuralConsistencyIssues`
 * (`@ifc-lite/parser`) with `physicalAxes` from `structuralPhysicalAxes`
 * (`@ifc-lite/create`).
 *
 * Each probe parses one real file whose physical and analytical models agree
 * (an Axis export, every beam and column linked to its curve members), and
 * first requires the checks to report nothing on it, so a check that always
 * fires fails. It then makes the bad case with an in-store edit from
 * `@ifc-lite/create`, exports, parses the export and requires the report to
 * name exactly the entity it broke:
 *
 * - `cap/check-unlinked-load-bearing`: remove the curve members linked to one
 *   column (and the loads on them); that column, and only it, is reported.
 * - `cap/check-axis-drift`: move one vertical column 0.3 m sideways; each
 *   member linked to it, and only those, is reported 0.3 m off its axis.
 * - `cap/check-unconnected-member`: remove a member's IfcRelConnectsStructuralMember
 *   relationships one by one; it is reported once the last one is gone, not before.
 */

import { parseStore } from '../lib/packages.mjs';

const FIXTURE = 'structural/ifc_structuralanalysisview/little_steel_frame-3D--Axis-Struc.ifc';
const DRIFT = 0.3;

const checks = (pkgs, store) => pkgs.parser.structuralConsistencyIssues(store, { physicalAxes: pkgs.create.structuralPhysicalAxes(store) });
const of = (issues, rule) => issues.filter((issue) => issue.rule === rule);
const sorted = (ids) => [...ids].sort((a, b) => a - b).join();
const sameIds = (a, b) => sorted(a) === sorted(b);

/** An editable copy of the fixture, the checks on its clean state, and how to check it after an edit. */
async function scene(ctx) {
  const file = ctx.corpus.files.find((f) => f.path === FIXTURE);
  if (!file) return { missing: ctx.corpus.nothingFound(`is ${FIXTURE}`) };
  const { mutations, exporter } = ctx.pkgs;
  const store = await parseStore(ctx.pkgs, file.bytes);
  const view = new mutations.MutablePropertyView(null, 'capability-checks');
  const editor = new mutations.StoreEditor(store, view);
  // Every rule, axis drift included: the clean file must report nothing at all.
  const axes = ctx.pkgs.create.structuralPhysicalAxes(store);
  const clean = ctx.pkgs.parser.structuralConsistencyIssues(store, { physicalAxes: axes });
  if (clean.length) throw new Error(`the unedited fixture already reports ${clean.length} issue(s), e.g. ${clean[0].message}`);
  /** The checks on the exported edit; axis drift (the costly rule) only when asked. */
  const recheck = async ({ axes = false } = {}) => {
    const edited = await parseStore(ctx.pkgs, new exporter.StepExporter(store, view).export({ schema: file.fileSchema, applyMutations: true }).content);
    return axes ? checks(ctx.pkgs, edited) : ctx.pkgs.parser.structuralConsistencyIssues(edited);
  };
  return { store, view, editor, axes, recheck, structural: ctx.pkgs.parser.extractStructuralOnDemand(store) };
}

/** Run `body` on a fresh scene and give every covered row its verdict. */
function probe(name, row, body) {
  return {
    name,
    level: 'capability',
    covers: (r) => r.id === row,
    async run(rows, ctx) {
      let result;
      try {
        const s = await scene(ctx);
        result = s.missing ?? { status: 'pass', evidence: [FIXTURE], ...(await body(ctx.pkgs, s)) };
      } catch (error) {
        result = { status: 'fail', reason: error instanceof Error ? error.message : String(error) };
      }
      return new Map(rows.map((r) => [r.id, result]));
    },
  };
}

/** The curve members linked to each physical element. */
function membersByElement(structural) {
  const out = new Map();
  for (const member of structural.members) {
    for (const element of member.physicalElementIds ?? []) out.set(element, [...(out.get(element) ?? []), member.expressId]);
  }
  return out;
}

const unlinkedLoadBearing = probe('capability:check-unlinked-load-bearing', 'cap/check-unlinked-load-bearing', async (pkgs, s) => {
  const columns = [...membersByElement(s.structural)].filter(([id]) => s.editor.getEntityType(id) === 'IfcColumn');
  if (!columns.length) throw new Error('no linked IfcColumn');
  const [column, members] = columns[0];
  // A member carrying loads cannot be removed while they act on it: remove them first.
  const globalIds = new Set(s.structural.members.filter((m) => members.includes(m.expressId)).map((m) => m.globalId));
  const loads = s.structural.activities.filter((a) => globalIds.has(a.appliesToGlobalId)).map((a) => a.expressId);
  for (const id of [...loads, ...members]) pkgs.create.removeStructuralEntityInStore(s.store, s.editor, id);
  const reported = of(await s.recheck(), 'structural-unlinked-element').map((issue) => issue.entityId);
  if (!sameIds(reported, [column])) throw new Error(`removed the members of #${column}; structural-unlinked-element reports ${JSON.stringify(reported)}`);
  return { removed: [...loads, ...members], reported };
});

const axisDrift = probe('capability:check-axis-drift', 'cap/check-axis-drift', async (pkgs, s) => {
  const { axes } = s;
  const vertical = ([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9 * Math.abs(b[2] - a[2]);
  const found = [...membersByElement(s.structural)].find(([id]) => s.editor.getEntityType(id) === 'IfcColumn' && axes.has(id) && vertical(axes.get(id)));
  if (!found) throw new Error('no linked vertical IfcColumn with a readable axis');
  const [column, members] = found;
  pkgs.create.transformElementsInStore({ dataStore: s.store, view: s.view, editor: s.editor, selected: [column], op: { kind: 'move', delta: [DRIFT, 0] } });
  const issues = of(await s.recheck({ axes: true }), 'structural-axis-drift');
  const wrong = issues.filter((issue) => issue.target !== column || !(Math.abs(issue.distance - DRIFT) < 1e-6));
  if (!sameIds(issues.map((issue) => issue.entityId), members) || wrong.length) {
    throw new Error(`moved #${column} ${DRIFT} m; expected members ${JSON.stringify(members)} at ${DRIFT} m, got ${JSON.stringify(issues.map((i) => [i.entityId, i.target, i.distance]))}`);
  }
  return { moved: column, reported: issues.map((issue) => ({ member: issue.entityId, distance: issue.distance })) };
});

const unconnectedMember = probe('capability:check-unconnected-member', 'cap/check-unconnected-member', async (pkgs, s) => {
  const member = s.structural.members.find((m) => (m.IfcRelConnectsStructuralMember ?? []).length >= 2);
  if (!member) throw new Error('no member with two IfcRelConnectsStructuralMember');
  const relationships = member.IfcRelConnectsStructuralMember.map((rel) => rel.expressId);
  const reports = [];
  for (const rel of relationships) {
    pkgs.create.removeStructuralEntityInStore(s.store, s.editor, rel);
    reports.push(of(await s.recheck(), 'structural-unconnected-member').map((issue) => issue.entityId));
  }
  const last = reports.pop();
  if (reports.some((ids) => ids.length) || !sameIds(last, [member.expressId])) {
    throw new Error(`removed the ${relationships.length} relationships of #${member.expressId} one by one; structural-unconnected-member reported ${JSON.stringify([...reports, last])}`);
  }
  return { removed: relationships, reported: last };
});

export default [unlinkedLoadBearing, axisDrift, unconnectedMember];
