/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `cap/check-stale-after-physical-change`: the `structural-stale-item` rule of
 * `structuralConsistencyIssues` (`@ifc-lite/parser`), with `physicalAxes` from
 * `structuralPhysicalAxes` (`@ifc-lite/create`).
 *
 * Derives an analytical model into the physical-only AxisVM roof truss (the
 * derive probe's input), exports it, then checks four edits of that export,
 * each exported and parsed again:
 *
 * - none: nothing is stale.
 * - an unrelated edit (rename one beam, add a property set to it): nothing is stale.
 * - move a horizontal beam 0.3 m along its own axis: exactly its members are
 *   stale, at 0.3 m, and `structural-axis-drift` reports none of them. Drift
 *   measures square to the axis, so this is the case only stored provenance
 *   can tell apart.
 * - move the same beam 0.3 m sideways: exactly its members are stale, at 0.3 m.
 */

import { parseStore } from '../lib/packages.mjs';
import { deriveInto, editSession, FRAME } from './capability-derive-toggle.mjs';

const MOVE = 0.3;
const sorted = (ids) => [...ids].sort((a, b) => a - b).join();

/** Every rule, axes included, on a parsed store. */
const checks = (pkgs, store) => pkgs.parser.structuralConsistencyIssues(store, { physicalAxes: pkgs.create.structuralPhysicalAxes(store) });

/** The derived export, opened for one edit; `check` exports the edit, parses it and runs every rule. */
async function open(ctx, text, schema) {
  const s = await editSession(ctx, text, schema);
  const check = async () => checks(ctx.pkgs, await parseStore(ctx.pkgs, s.text()));
  const move = (id, delta) => ctx.pkgs.create.transformElementsInStore({ dataStore: s.store, view: s.view, editor: s.editor, selected: [id], op: { kind: 'move', delta } });
  return { ...s, check, move };
}

async function measure(ctx, file) {
  const text = await deriveInto(ctx, file);
  const base = await open(ctx, text, file.schema);
  const structural = ctx.pkgs.parser.extractStructuralOnDemand(base.store);
  const axes = ctx.pkgs.create.structuralPhysicalAxes(base.store);
  // A beam drawn along x or y, so a plan move can go along its axis and square to it.
  const flat = ([a, b]) => Math.abs(b[2] - a[2]) < 1e-9 && (Math.abs(b[1] - a[1]) < 1e-9 || Math.abs(b[0] - a[0]) < 1e-9);
  const beam = [...axes].find(([id, axis]) => base.editor.getEntityType(id) === 'IfcBeam' && flat(axis));
  if (!beam) throw new Error('no derived IfcBeam drawn along x or y');
  const [beamId, [a, b]] = beam;
  const members = structural.members.filter((m) => (m.physicalElementIds ?? []).includes(beamId)).map((m) => m.expressId);
  if (!members.length) throw new Error(`derive linked no member to #${beamId}`);
  const alongX = Math.abs(b[1] - a[1]) < 1e-9;
  const along = alongX ? [MOVE, 0] : [0, MOVE];
  const across = alongX ? [0, MOVE] : [MOVE, 0];
  const stale = (issues) => issues.filter((i) => i.rule === 'structural-stale-item');

  const clean = stale(checks(ctx.pkgs, base.store));
  if (clean.length) throw new Error(`the derived model already reports ${clean.length} stale member(s): ${clean[0].message}`);

  const unrelated = await open(ctx, text, file.schema);
  unrelated.editor.setAttribute(beamId, 'Name', 'Renamed after derive');
  unrelated.editor.addPropertySet(beamId, 'Probe_Unrelated', [{ name: 'Note', value: 'not geometry', type: 'LABEL' }]);
  const afterUnrelated = stale(await unrelated.check());
  if (afterUnrelated.length) throw new Error(`renaming #${beamId} and adding a property set reported ${JSON.stringify(afterUnrelated.map((i) => i.entityId))} stale`);

  const results = {};
  const issuesAfter = {};
  for (const [label, delta] of [['along', along], ['across', across]]) {
    const s = await open(ctx, text, file.schema);
    s.move(beamId, delta);
    const issues = issuesAfter[label] = await s.check();
    const found = stale(issues);
    const wrong = found.filter((i) => i.target !== beamId || !(Math.abs(i.distance - MOVE) < 1e-6));
    if (sorted(found.map((i) => i.entityId)) !== sorted(members) || wrong.length) {
      throw new Error(`moved #${beamId} ${MOVE} m ${label} its axis; expected members ${JSON.stringify(members)} stale at ${MOVE} m, got ${JSON.stringify(found.map((i) => [i.entityId, i.target, i.distance]))}`);
    }
    results[label] = found.map((i) => ({ member: i.entityId, distance: i.distance }));
  }
  const drift = issuesAfter.along.filter((i) => i.rule === 'structural-axis-drift' && i.target === beamId);
  if (drift.length) throw new Error(`moving #${beamId} along its axis made structural-axis-drift report ${JSON.stringify(drift.map((i) => i.entityId))}`);
  return { moved: beamId, members, ...results };
}

export default {
  name: 'capability:check-stale-after-physical-change',
  level: 'capability',
  covers: (r) => r.id === 'cap/check-stale-after-physical-change',
  async run(rows, ctx) {
    const file = ctx.corpus.files.find((f) => f.path === FRAME);
    let result;
    if (!file) result = ctx.corpus.nothingFound(`is ${FRAME}`);
    else {
      try {
        result = { status: 'pass', evidence: [FRAME], ...(await measure(ctx, file)) };
      } catch (error) {
        result = { status: 'fail', reason: error instanceof Error ? error.message : String(error) };
      }
    }
    return new Map(rows.map((r) => [r.id, result]));
  },
};
