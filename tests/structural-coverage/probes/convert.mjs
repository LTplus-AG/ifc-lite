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
 * credit for the row even when the record comes back. Where the schemas decide
 * what comes back, see `attributeProblem` and `CONSTANT_SUBTYPE`.
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

const names = new WeakMap();
/** STEP keyword -> registry entity name, built once per registry. */
function entityName(registry, keyword) {
  if (!names.has(registry)) names.set(registry, new Map(Object.keys(registry.entities).map((n) => [n.toUpperCase(), n])));
  return names.get(registry).get(keyword);
}

const acyclic = new WeakSet();
/** Refuse a registry whose selects nest in a cycle: a codegen fault, not a converter defect. Checked once per registry. */
function assertAcyclicSelects(registry) {
  if (acyclic.has(registry)) return;
  const state = new Map();
  const visit = (type) => {
    if (state.get(type) === 'open') throw new Error(`select ${type} nests in a cycle: the schema registry is malformed`);
    if (state.has(type) || !Object.hasOwn(registry.selects, type)) return;
    state.set(type, 'open');
    for (const m of registry.selects[type]) visit(m);
    state.set(type, 'done');
  };
  for (const type of Object.keys(registry.selects)) visit(type);
  acyclic.add(registry);
}

/** Whether a slot of `type` accepts a reference to an entity named `target`. */
function acceptsRef(registry, type, target) {
  if (Object.hasOwn(registry.entities, type)) return registry.entities[target]?.inheritanceChain.includes(type) ?? false;
  return Object.hasOwn(registry.selects, type) && registry.selects[type].some((m) => acceptsRef(registry, m, target));
}

/** Whether a SELECT of `type` has a non-entity member, so a typed value can fill it. */
function acceptsValue(registry, type) {
  return registry.selects[type].some((m) => !Object.hasOwn(registry.entities, m) && (!Object.hasOwn(registry.selects, m) || acceptsValue(registry, m)));
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
  if (Object.hasOwn(registry.entities, t)) return `bare value in entity slot ${t}`;
  const select = Object.hasOwn(registry.selects, t);
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
  assertAcyclicSelects(registry);
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

/**
 * IFC4 curve and surface actions with PredefinedType CONST come back as the
 * constant subtype. IFC2X3 has no curve or surface action: IfcStructuralAction is
 * ONEOF(IfcStructuralLinearAction, IfcStructuralPlanarAction,
 * IfcStructuralPointAction) (packages/codegen/schemas/IFC2X3_TC1.exp:7230), so
 * the converter must write a constant one as the IFC2X3 linear or planar action,
 * which IFC4 keeps as the subtype whose rule ConstPredefinedType pins
 * PredefinedType to CONST (IFC4_ADD2_TC1.exp:9449, :9582). A non-constant action
 * coming back as the subtype is still a class change.
 */
const CONSTANT_SUBTYPE = new Map([
  ['IFCSTRUCTURALCURVEACTION', 'IFCSTRUCTURALLINEARACTION'],
  ['IFCSTRUCTURALSURFACEACTION', 'IFCSTRUCTURALPLANARACTION'],
]);

const slotOf = (registry, keyword, name) => {
  const entity = entityName(registry, keyword);
  const slots = entity ? registry.entities[entity].allAttributes : [];
  const index = slots.findIndex((s) => s.name === name);
  return index === -1 ? null : { ...slots[index], index };
};

const guidIndexes = new WeakMap();
/**
 * GlobalId -> record of one parsed file, built once per file and type index.
 * Leaves out only records `types` knows are not IfcRoot subtypes: a keyword the
 * schema lacks stays in, so a record copied through under it is found.
 */
function byGuid(step, types) {
  if (!guidIndexes.has(step)) guidIndexes.set(step, new WeakMap());
  const perTypes = guidIndexes.get(step);
  if (!perTypes.has(types)) {
    const rooted = [...step.entities.values()].filter((e) => types.get(e.type)?.rooted !== false && typeof e.args[0] === 'string');
    perTypes.set(types, new Map(rooted.map((e) => [e.args[0], e])));
  }
  return perTypes.get(types);
}

/**
 * Intermediate records that a rooted row's sampled records became under another
 * class (matched by GlobalId) and that do not conform: `nonConforming` checks
 * only records of the row's own entity.
 */
export function renamedNonConforming(row, file, there, other) {
  const mids = sampleOf(row, file).map((rec) => byGuid(there, other.types).get(rec.args[0]))
    .filter((mid) => mid && mid.type !== row.entity.toUpperCase());
  const ids = new Set(mids.map((mid) => mid.id));
  return [...new Set(mids.map((mid) => mid.type))]
    .flatMap((type) => nonConforming(there, entityName(other.registry, type) ?? type, other.registry))
    .filter((r) => ids.has(r.id));
}

/** Why a non-empty `value` cannot fill a required slot: `slotMismatch`, plus enum membership. */
function fillProblem(value, slot, registry, step) {
  const members = Object.hasOwn(registry.enums, slot.type) ? registry.enums[slot.type] : null;
  if (members && !(typeof value === 'object' && members.includes(value.enum))) return `not a member of ${slot.type}`;
  return slotMismatch(value, slot.type, false, registry, step);
}

/**
 * Why attribute `row.own[i]` did not come back as the source held it, or null.
 * `r` holds the record's `want`/`have` tuples, the record that came back
 * (`got`) and the round trip's files (`there`, `back`). A value that came back
 * as written always holds. Where the source left it empty (`$`, or `*`, which
 * `normalize` reads as empty too), the schemas decide:
 * - the intermediate schema requires the slot, so the converter had to write a
 *   value and cannot know the source had none. IFC2X3 declares
 *   `DestabilizingLoad : BOOLEAN` (IFC2X3_TC1.exp:7236) where IFC4 has
 *   `OPTIONAL IfcBoolean` (IFC4_ADD2_TC1.exp:9356); ProjectedOrTrue is the same
 *   on the IFC2X3 linear and planar actions. The written value must come back,
 *   and fill the source schema's slot when that one is required too.
 * - otherwise, the source's own schema requires the slot, so the source does not
 *   conform there: any value that fills the slot holds (`fillProblem`).
 */
function attributeProblem(i, { row, schemas, want: wants, have: haves, got, there, back }) {
  const a = row.own[i], want = wants[i], have = haves[i];
  if (equal(want, have)) return null;
  const differs = `${a} ${show(have)}, was ${show(want)}`;
  if (want !== null) return differs;
  const own = slotOf(schemas.own.registry, row.entity.toUpperCase(), a);
  const why = own && !own.optional ? fillProblem(got.args[own.index], own, schemas.own.registry, back) : null;
  const unfit = why && `${a} left empty in the source, which ${row.schema} requires; came back ${why}`;
  const mid = byGuid(there, schemas.other.types).get(got.args[0]);
  const forced = mid && slotOf(schemas.other.registry, mid.type, a);
  if (forced && !forced.optional) {
    const written = normalize(mid.args[forced.index], there, schemas.other.types, 'type');
    return equal(written, have) ? unfit : `${differs} (written ${show(written)} in ${OTHER[row.schema]}, which requires it)`;
  }
  return own && !own.optional ? unfit : differs;
}

/** Compare one file's sample of `row` with the round trip `rt` ({ there, step }). */
export function compareFile(row, file, { there, step: back }, schemas) {
  const { types } = schemas.own;
  const problems = [];
  let anyHeld = false;
  const sample = sampleOf(row, file);
  if (row.rooted) {
    const predefined = row.own.indexOf('PredefinedType');
    const constEnum = (record) => record.args[row.attributes.indexOf('PredefinedType')]?.enum === 'CONST';
    for (const rec of sample) {
      const got = byGuid(back, types).get(rec.args[0]);
      const where = `${file.path}#${rec.id}`;
      if (!got) { problems.push(`${where}: lost`); continue; }
      anyHeld = true;
      const want = tuple(row, rec, file.step, types);
      const have = tuple(row, got, back, types);
      // An empty (invalid) source PredefinedType may come back filled as CONST.
      const constant = CONSTANT_SUBTYPE.get(rec.type) === got.type && constEnum(got) && (constEnum(rec) || want[predefined] === null);
      if (got.type !== rec.type && !constant) { problems.push(`${where}: came back as ${got.type}`); continue; }
      // IFC4's constant subtypes pin PredefinedType to CONST (ConstPredefinedType), so any other value is schema-invalid.
      if ([...CONSTANT_SUBTYPE.values()].includes(got.type) && !constEnum(got)) {
        problems.push(`${where}: came back as ${got.type} with PredefinedType ${show(have[predefined])}, which ConstPredefinedType requires to be CONST`);
        continue;
      }
      const r = { row, schemas, want, have, got, there, back };
      row.own.forEach((_, i) => {
        const why = attributeProblem(i, r);
        if (why) problems.push(`${where}: ${why}`);
      });
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
    const schemaOf = (schema) => cached(ctx, `convert:schema:${schema}`, () => ({ registry: ctx.pkgs.parser.getSchemaRegistryForVersion(schema), types: ctx.tables[schema].types }));
    for (const row of rows) {
      const carriers = ctx.corpus.carriers(row.schema, row.entity)
        .sort((a, b) => a.bytes.length - b.bytes.length || a.path.localeCompare(b.path)).slice(0, MAX_FILES);
      if (!carriers.length) { out.set(row.id, ctx.corpus.nothingCarries(row.schema, row.entity)); continue; }
      const schemas = { own: schemaOf(row.schema), other: schemaOf(OTHER[row.schema]) };
      const problems = [];
      let checked = 0;
      let anyHeld = false;
      for (const file of carriers) {
        const rt = await roundTrip(ctx, file, row.schema);
        if (rt.error) { problems.push(`${file.path}: ${row.schema} -> ${OTHER[row.schema]} -> ${row.schema} threw: ${rt.error.message.split('\n')[0]}`); checked += sampleOf(row, file).length; continue; }
        const copied = nonConforming(rt.there, row.entity, schemas.other.registry);
        const renamed = row.rooted ? renamedNonConforming(row, file, rt.there, schemas.other) : [];
        if (copied.length || renamed.length) {
          problems.push(copied.length
            ? `${file.path}: ${copied.length} of ${rt.there.count(row.entity)} ${row.entity} record(s) in the ${OTHER[row.schema]} file do not conform to ${OTHER[row.schema]} (e.g. ${copied[0].why})`
            : `${file.path}: ${renamed.length} ${row.entity} record(s) became records that do not conform to ${OTHER[row.schema]} (e.g. #${renamed[0].id} ${renamed[0].why})`);
          checked += sampleOf(row, file).length;
          continue;
        }
        const r = compareFile(row, file, rt, schemas);
        problems.push(...r.problems);
        checked += r.checked;
        anyHeld ||= r.anyHeld;
      }
      out.set(row.id, { ...verdict(checked, problems, { anyHeld }), evidence: carriers.map((f) => f.path) });
    }
    return out;
  },
};
