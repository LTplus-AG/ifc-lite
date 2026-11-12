/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Level `render` for connections and actions: `structuralGlyphs`
 * (`@ifc-lite/parser/structural-glyphs`), the plain-data list the viewer's glyph overlay draws,
 * holds a glyph for the record at a finite position.
 *
 * Which records must draw is read from the file, not from the product: a
 * connection whose `AppliedCondition` record holds a true or non-zero value
 * (a restraint), and an action whose `AppliedLoad`, a nested configuration
 * value or, for the IFC2X3 varying actions, any `SubsequentAppliedLoads`
 * record holds a non-zero number. A free joint or a valueless load draws
 * nothing and is not checked. Pass needs every such record drawn; a row whose
 * corpus has no such record is unproven (fail).
 *
 * Members (meshes) and reactions (results) are not covered here.
 */

import { cached, storeOf } from '../lib/packages.mjs';
import { verdict } from '../lib/values.mjs';

/** True or a non-zero number anywhere in a record's attributes, following references below it. */
function holdsValue(step, rec, seen = new Set()) {
  if (!rec || seen.has(rec.id)) return false;
  seen.add(rec.id);
  const visit = (v) => {
    if (v === null || v === undefined) return false;
    if (typeof v === 'number') return v !== 0;
    if (Array.isArray(v)) return v.some(visit);
    if (typeof v !== 'object') return false;
    if ('enum' in v) return v.enum === 'T';
    if ('type' in v) return visit(v.value);
    if ('ref' in v) return holdsValue(step, step.get(v.ref), seen);
    return false;
  };
  // A configuration's `Locations` are positions, not loads: only its `Values` count.
  if (rec.type === 'IFCSTRUCTURALLOADCONFIGURATION') return visit(rec.args[1]);
  // Skip `Name` (first attribute of every load and condition).
  return rec.args.slice(1).some(visit);
}

const isConnection = (row) => row.family === 'item' && row.entity.endsWith('Connection');
const isAction = (row) => row.family === 'activity' && /Action/.test(row.entity);

/** Records of the row that must draw: the file's own statement of a support or a load. */
function mustDraw(row, step, rec) {
  const at = (name) => rec.args[row.attributes.indexOf(name)];
  if (isConnection(row)) return holdsValue(step, step.get(at('AppliedCondition')));
  const loads = [at('AppliedLoad'), ...(row.attributes.includes('SubsequentAppliedLoads') ? at('SubsequentAppliedLoads') ?? [] : [])];
  return loads.some((ref) => holdsValue(step, step.get(ref)));
}

/** The glyph source ids of one file, or the error that stopped the product. */
function glyphSources(ctx, file) {
  return cached(ctx, `render:${file.path}`, async () => {
    try {
      const store = await storeOf(ctx, file);
      const glyphs = ctx.pkgs.structuralGlyphs.structuralGlyphs(store, ctx.pkgs.parser.extractStructuralOnDemand(store));
      const drawn = new Set();
      for (const g of glyphs) if (g.position.every(Number.isFinite)) drawn.add(g.source.expressId);
      return { drawn };
    } catch (e) {
      return { error: `glyphs threw: ${e.message}` };
    }
  });
}

export default {
  name: 'render:structural-glyphs',
  level: 'render',
  covers: (row) => isConnection(row) || isAction(row),
  async run(rows, ctx) {
    const out = new Map();
    for (const row of rows) {
      const carriers = ctx.corpus.carriers(row.schema, row.entity);
      if (!carriers.length) { out.set(row.id, ctx.corpus.nothingCarries(row.schema, row.entity)); continue; }
      const problems = [];
      let checked = 0;
      const missed = [];
      for (const file of carriers) {
        const expected = file.step.of(row.entity).filter((rec) => mustDraw(row, file.step, rec));
        if (!expected.length) continue;
        const { drawn, error } = await glyphSources(ctx, file);
        if (error) { problems.push(`${file.path}: ${error}`); continue; }
        for (const rec of expected) {
          checked += 1;
          if (!drawn.has(rec.id)) missed.push(`${file.path}#${rec.id}`);
        }
      }
      const what = isConnection(row) ? 'restraining support condition' : 'non-zero load';
      if (missed.length) problems.unshift(`${missed.length} of ${checked} record(s) with a ${what} draw no glyph, e.g. ${missed[0]}`);
      const result = checked
        ? verdict(checked, problems, { anyHeld: missed.length < checked })
        : { status: 'fail', reason: `no corpus record of ${row.entity} carries a ${what}, so a glyph is unproven` };
      out.set(row.id, { ...result, evidence: carriers.map((f) => f.path) });
    }
    return out;
  },
};
