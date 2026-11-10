/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Level `create`: an in-store builder (`packages/create/src/in-store/structural-*.ts`)
 * authors the entity in a blank model of the row's schema, the STEP export of
 * that model declares the schema and re-parses, and the exported record carries
 * the values the builder was given.
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

function matchRecord(row, exported, expect, types) {
  let best = null;
  for (const rec of exported.of(row.entity)) {
    const diffs = Object.entries(expect).flatMap(([attr, want]) => {
      // An expectation naming an attribute this schema does not have is a scene bug, said so.
      if (!row.attributes.includes(attr)) return [`scene expects ${attr}, which ${row.schema} ${row.entity} does not have`];
      const got = normalize(rec.args[row.attributes.indexOf(attr)], exported, types);
      return equal(want, got) ? [] : [`${attr} ${show(got)}, expected ${show(want)}`];
    });
    if (!diffs.length) return { rec, diffs };
    if (!best || diffs.length < best.diffs.length) best = { rec, diffs };
  }
  return best;
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
      const problems = [];
      if (catalogueSchema(scene.exported.schema) !== row.schema) problems.push(`export declares ${scene.exported.schema}, not ${row.schema}`);
      if (scene.reparse) problems.push(`export does not re-parse: ${scene.reparse}`);
      // A record that is exported but carries wrong values is partial evidence; nothing exported is a failure.
      let exportedAny = false;
      for (const step of steps) {
        const error = scene.errors.get(step.id);
        if (error) { problems.push(`${step.id}: ${error}`); continue; }
        const m = matchRecord(row, scene.exported, step.emits[row.entity], types);
        if (!m) { problems.push(`${step.id}: no ${row.entity} record in the export`); continue; }
        exportedAny = true;
        if (m.diffs.length) problems.push(`${step.id}: ${m.diffs.join(', ')}`);
      }
      const evidence = steps.map((s) => s.builder);
      out.set(row.id, problems.length
        ? { status: exportedAny ? 'partial' : 'fail', reason: problems.join('; '), evidence }
        : { status: 'pass', evidence });
    }
    return out;
  },
};
