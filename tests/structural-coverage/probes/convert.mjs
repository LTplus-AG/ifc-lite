/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Level `convert`: the entity survives a round trip through the schema
 * converter (`exportToStep` with a target schema, packages/export):
 * IFC4 -> IFC2X3 -> IFC4 for IFC4 rows, IFC2X3 -> IFC4 -> IFC2X3 for IFC2X3 rows.
 *
 * Every sampled record must come back as the same entity with the same own
 * attribute values. Rooted records are matched by GlobalId; resource records
 * (no GlobalId) by value, as a multiset. References compare by the target's
 * GlobalId, or by its type when it has none, since a re-export may renumber.
 * A record that comes back as another entity is partial evidence; one that is
 * gone is a failure. The converter throwing is the product failing, not the probe.
 * Every record of the entity in the intermediate file must exist in the
 * intermediate schema with that schema's attribute count. A record copied
 * through unconverted makes the file schema-invalid, so that file earns no
 * credit for the row even when the record comes back. Attribute TYPES are not
 * checked (the generated tables carry none): a value copied into a slot of
 * another type with the same arity is not caught.
 */

import { CONVERT_HOP as OTHER } from '../catalogue.mjs';
import { cached, parseStore, storeOf } from '../lib/packages.mjs';
import { readStep } from '../lib/step.mjs';
import { equal, normalize, show, verdict } from '../lib/values.mjs';

const MAX_FILES = 2;
const MAX_RECORDS = 25;

function roundTrip(ctx, file, schema) {
  return cached(ctx, `convert:${file.path}`, () => (async () => {
    const { exportToStep } = ctx.pkgs.exporter;
    const there = exportToStep(await storeOf(ctx, file), { schema: OTHER[schema] });
    return { there: readStep(there), step: readStep(exportToStep(await parseStore(ctx.pkgs, there), { schema })) };
  })().catch((error) => ({ error })));
}

/** Records of `entity` in `intermediate` that do not exist in its schema `target` with that schema's attribute count. */
export function nonConforming(intermediate, entity, target) {
  return intermediate.of(entity).filter((rec) => target === undefined || rec.args.length !== target.attributes.length);
}

function tuple(row, record, step, types) {
  return row.own.map((a) => normalize(record.args[row.attributes.indexOf(a)], step, types, 'type'));
}

function compareFile(row, file, back, types) {
  const problems = [];
  let anyHeld = false;
  const sample = file.step.of(row.entity).slice(0, MAX_RECORDS);
  if (row.rooted) {
    const byGuid = new Map([...back.entities.values()].filter((e) => typeof e.args?.[0] === 'string').map((e) => [e.args[0], e]));
    for (const rec of sample) {
      const got = byGuid.get(rec.args[0]);
      const where = `${file.path}#${rec.id}`;
      if (!got) { problems.push(`${where}: lost`); continue; }
      if (got.type !== rec.type) { problems.push(`${where}: came back as ${got.type}`); anyHeld = true; continue; }
      anyHeld = true;
      const want = tuple(row, rec, file.step, types);
      const have = tuple(row, got, back, types);
      row.own.forEach((a, i) => { if (!equal(want[i], have[i])) problems.push(`${where}: ${a} ${show(have[i])}, was ${show(want[i])}`); });
    }
  } else {
    const pool = back.of(row.entity).map((r) => tuple(row, r, back, types));
    for (const rec of sample) {
      const want = tuple(row, rec, file.step, types);
      const at = pool.findIndex((t) => equal(t, want));
      if (at === -1) problems.push(`${file.path}#${rec.id}: no ${row.entity} with its values came back`);
      else { pool.splice(at, 1); anyHeld = true; }
    }
  }
  return { problems, anyHeld, checked: sample.length };
}

export default {
  name: 'convert:exportToStep-round-trip',
  level: 'convert',
  async run(rows, ctx) {
    const out = new Map();
    for (const row of rows) {
      const carriers = ctx.corpus.carriers(row.schema, row.entity)
        .sort((a, b) => a.bytes.length - b.bytes.length || a.path.localeCompare(b.path)).slice(0, MAX_FILES);
      if (!carriers.length) { out.set(row.id, ctx.corpus.nothingCarries(row.schema, row.entity)); continue; }
      const { types } = ctx.tables[row.schema];
      const target = ctx.tables[OTHER[row.schema]].table.get(row.entity);
      const problems = [];
      let checked = 0;
      let anyHeld = false;
      for (const file of carriers) {
        const rt = await roundTrip(ctx, file, row.schema);
        if (rt.error) { problems.push(`${file.path}: ${row.schema} -> ${OTHER[row.schema]} -> ${row.schema} threw: ${rt.error.message.split('\n')[0]}`); checked++; continue; }
        const copied = nonConforming(rt.there, row.entity, target);
        if (copied.length) {
          problems.push(`${file.path}: ${copied.length} ${row.entity} record(s) in the ${OTHER[row.schema]} file do not conform to ${OTHER[row.schema]} (${target ? `${target.attributes.length} attributes expected` : 'no such entity'})`);
          checked += Math.min(file.step.count(row.entity), MAX_RECORDS);
          continue;
        }
        const r = compareFile(row, file, rt.step, types);
        problems.push(...r.problems);
        checked += r.checked;
        anyHeld ||= r.anyHeld;
      }
      out.set(row.id, { ...verdict(checked, problems, { anyHeld }), evidence: carriers.map((f) => f.path) });
    }
    return out;
  },
};
