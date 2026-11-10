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
 * Every record of the entity in the intermediate file must conform to the
 * intermediate schema's typed registry (see `slotMismatch`). A record copied
 * through unconverted makes the file schema-invalid, so that file earns no
 * credit for the row even when the record comes back.
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

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const names = new WeakMap();
/** STEP keyword -> registry entity name, built once per registry. */
function entityName(registry, keyword) {
  if (!names.has(registry)) names.set(registry, new Map(Object.keys(registry.entities).map((n) => [n.toUpperCase(), n])));
  return names.get(registry).get(keyword);
}

/** Whether a slot of `type` accepts a reference to an entity named `target`. */
function acceptsRef(registry, type, target, depth = 0) {
  if (own(registry.entities, type)) return registry.entities[target]?.inheritanceChain.includes(type) ?? false;
  return depth < 8 && own(registry.selects, type) && registry.selects[type].some((m) => acceptsRef(registry, m, target, depth + 1));
}

/** Whether a SELECT of `type` has a non-entity member, so a typed value can fill it. */
function acceptsValue(registry, type, depth = 0) {
  return depth < 8 && registry.selects[type].some((m) => !own(registry.entities, m) && (!own(registry.selects, m) || acceptsValue(registry, m, depth + 1)));
}

/**
 * Why `value` cannot fill a slot of `type` in `registry`, or null. A reference
 * must resolve in `step` to an entity the slot admits; a typed value fits only
 * a SELECT with value members; a bare value fits only a defined-type, enum or
 * primitive slot; `$` only an optional slot. Lists are checked element by element.
 */
function slotMismatch(value, type, optional, registry, step) {
  const t = type.replace(/(\[\])+$/, '');
  if (value === '*') return null;
  if (value === null) return optional ? null : 'required value empty';
  if (Array.isArray(value)) return value.map((v) => slotMismatch(v, t, false, registry, step)).find(Boolean) ?? null;
  if (typeof value === 'object' && 'ref' in value) {
    const target = step.get(value);
    if (!target) return 'reference to a missing record';
    const name = entityName(registry, target.type);
    if (!name) return `reference to ${target.type}, which the schema lacks`;
    return acceptsRef(registry, t, name) ? null : `reference to ${name} in ${t}`;
  }
  if (own(registry.entities, t)) return `bare value in entity slot ${t}`;
  const select = own(registry.selects, t);
  const typed = typeof value === 'object' && 'type' in value;
  if (typed && !(select && acceptsValue(registry, t))) return `typed ${value.type} in ${t}`;
  if (!typed && select) return `bare value in SELECT ${t}`;
  return null;
}

/**
 * Records of `entity` in `intermediate` that do not conform to its schema, as
 * `registry` (a parser SchemaRegistry, typed) defines it: the entity is missing,
 * the attribute count differs, or a value does not fit its slot. Returns
 * `{ id, why }` per record.
 */
export function nonConforming(intermediate, entity, registry) {
  const slots = registry.entities[entity]?.allAttributes;
  return intermediate.of(entity).flatMap((rec) => {
    if (!slots) return [{ id: rec.id, why: 'no such entity' }];
    if (rec.args.length !== slots.length) return [{ id: rec.id, why: `${rec.args.length} attributes, ${slots.length} expected` }];
    for (const [i, slot] of slots.entries()) {
      const why = slotMismatch(rec.args[i], slot.type, slot.optional, registry, intermediate);
      if (why) return [{ id: rec.id, why: `${slot.name}: ${why}` }];
    }
    return [];
  });
}

/** The records of the row's entity a file contributes: every outcome counts this many as checked. */
const sampleOf = (row, file) => file.step.of(row.entity).slice(0, MAX_RECORDS);

function tuple(row, record, step, types) {
  return row.own.map((a) => normalize(record.args[row.attributes.indexOf(a)], step, types, 'type'));
}

function compareFile(row, file, back, types) {
  const problems = [];
  let anyHeld = false;
  const sample = sampleOf(row, file);
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
      const otherRegistry = ctx.pkgs.parser.getSchemaRegistryForVersion(OTHER[row.schema]);
      const problems = [];
      let checked = 0;
      let anyHeld = false;
      for (const file of carriers) {
        const rt = await roundTrip(ctx, file, row.schema);
        if (rt.error) { problems.push(`${file.path}: ${row.schema} -> ${OTHER[row.schema]} -> ${row.schema} threw: ${rt.error.message.split('\n')[0]}`); checked += sampleOf(row, file).length; continue; }
        const copied = nonConforming(rt.there, row.entity, otherRegistry);
        if (copied.length) {
          problems.push(`${file.path}: ${copied.length} of ${rt.there.count(row.entity)} ${row.entity} record(s) in the ${OTHER[row.schema]} file do not conform to ${OTHER[row.schema]} (e.g. ${copied[0].why})`);
          checked += sampleOf(row, file).length;
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
