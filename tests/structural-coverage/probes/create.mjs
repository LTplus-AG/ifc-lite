/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Level `create`: an in-store builder (`packages/create/src/in-store/structural-*.ts`)
 * authors the entity in a blank model of the row's schema, the STEP export of
 * that model declares the schema and re-parses, the exported record carries the
 * values the builder was given (typed values compared typed), and every
 * exported record of the entity conforms to the schema's typed registry, the
 * same check the convert probe applies: a SELECT slot holds a typed value, a
 * required slot is not `$`, whether or not the scene names the attribute.
 *
 * The builders run as one scene per schema (`SCENE` in create-scene.mjs); each
 * step names the entities it emits and the attribute values to expect. A row
 * no step emits fails as "no in-store builder emits it". A later lane adds a
 * builder by adding one step there.
 */

import { parseStore } from '../lib/packages.mjs';
import { readStep } from '../lib/step.mjs';
import { catalogueSchema } from '../lib/corpus.mjs';
import { equal, normalize, show } from '../lib/values.mjs';
import { blankModel, stepsFor } from './create-scene.mjs';
import { nonConforming } from './convert.mjs';

async function buildScene(ctx, schema) {
  const { create, mutations, exporter } = ctx.pkgs;
  const store = await parseStore(ctx.pkgs, blankModel(schema));
  const view = new mutations.MutablePropertyView(null, 'structural-coverage');
  const editor = new mutations.StoreEditor(store, view);
  const storeyId = store.entityIndex.byType.get('IFCBUILDINGSTOREY')?.[0];
  const anchor = create.resolveSpatialAnchor(store, storeyId, view);
  const done = new Map();
  const errors = new Map();
  for (const step of stepsFor(schema)) {
    const missing = (step.needs ?? []).filter((n) => !done.has(n));
    if (missing.length) { errors.set(step.id, `needs ${missing.join(', ')}, which did not build`); continue; }
    try {
      done.set(step.id, step.build({ create, editor, anchor, done }));
    } catch (e) {
      errors.set(step.id, `${step.builder} threw: ${e.message}`);
    }
  }
  const text = new TextDecoder().decode(new exporter.StepExporter(store, view).export({ schema, applyMutations: true }).content);
  const exported = readStep(text);
  let reparse = null;
  try { await parseStore(ctx.pkgs, text); } catch (e) { reparse = e.message; }
  return { errors, exported, reparse };
}

function matchRecord(row, exported, values, types) {
  let best = null;
  for (const rec of exported.of(row.entity)) {
    const diffs = Object.entries(values).flatMap(([attr, want]) => {
      const got = normalize(rec.args[row.attributes.indexOf(attr)], exported, types, 'id', true);
      return equal(want, got) ? [] : [`${attr} ${show(got)}, expected ${show(want)}`];
    });
    if (!diffs.length) return { rec, diffs };
    if (!best || diffs.length < best.diffs.length) best = { rec, diffs };
  }
  return best;
}

/**
 * One step's export of `row.entity`, judged: fail when nothing was exported or
 * an exported record does not conform to `registry` (the schema's typed
 * SchemaRegistry); partial when values differ or some stay unchecked; else pass.
 */
export function checkExport(row, exported, expect, types, registry) {
  const { unchecked = [], ...values } = expect;
  const m = matchRecord(row, exported, values, types);
  if (!m) return { status: 'fail', reason: `no ${row.entity} record in the export` };
  const problems = [...m.diffs];
  // An expectation that leaves attributes unchecked can never earn a full pass.
  if (unchecked.length) problems.push(`no expected value yet for ${unchecked.join(', ')}`);
  const bad = nonConforming(exported, row.entity, registry);
  if (bad.length) problems.push(`${bad.length} of ${exported.count(row.entity)} exported record(s) do not conform to ${row.schema}, e.g. #${bad[0].id} ${bad[0].why}`);
  if (!problems.length) return { status: 'pass' };
  return { status: bad.length ? 'fail' : 'partial', reason: problems.join(', '), invalid: bad.length > 0 };
}

export default {
  name: 'create:in-store-builders',
  level: 'create',
  async run(rows, ctx) {
    const out = new Map();
    const scenes = new Map();
    for (const row of rows) {
      const steps = stepsFor(row.schema).filter((s) => s.emits[row.entity]);
      if (!steps.length) { out.set(row.id, { status: 'fail', reason: `no in-store builder emits ${row.entity}` }); continue; }
      // A throw outside a builder step fails that schema's rows only.
      if (!scenes.has(row.schema)) {
        scenes.set(row.schema, await buildScene(ctx, row.schema).catch((e) => ({ fatal: `building the ${row.schema} scene threw: ${e.message}` })));
      }
      const scene = scenes.get(row.schema);
      if (scene.fatal) { out.set(row.id, { status: 'fail', reason: scene.fatal }); continue; }
      const { types } = ctx.tables[row.schema];
      const registry = ctx.pkgs.parser.getSchemaRegistryForVersion(row.schema);
      const problems = [];
      if (catalogueSchema(scene.exported.schema) !== row.schema) problems.push(`export declares ${scene.exported.schema}, not ${row.schema}`);
      if (scene.reparse) problems.push(`export does not re-parse: ${scene.reparse}`);
      // Wrong values in a valid export are partial evidence; nothing exported, or an invalid export, is a failure.
      let exportedAny = false;
      let invalid = false;
      for (const step of steps) {
        const error = scene.errors.get(step.id);
        if (error) { problems.push(`${step.id}: ${error}`); continue; }
        const r = checkExport(row, scene.exported, step.emits[row.entity], types, registry);
        if (r.status !== 'fail' || r.invalid) exportedAny = true;
        invalid ||= r.invalid === true;
        if (r.reason) problems.push(`${step.id}: ${r.reason}`);
      }
      const evidence = steps.map((s) => s.builder);
      out.set(row.id, problems.length
        ? { status: exportedAny && !invalid ? 'partial' : 'fail', reason: problems.join('; '), evidence }
        : { status: 'pass', evidence });
    }
    return out;
  },
};
