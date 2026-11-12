/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Level `card`: the viewer's properties card shows the entity with the values
 * the file holds.
 *
 * The card's content is `structuralCardSections` in
 * `apps/viewer/src/components/viewer/properties/structural-card-model.ts`: the
 * plain-data sections `StructuralCard` renders, one per entity it shows, each a
 * list of rows keyed by EXPRESS attribute name. The probe imports that module
 * from source and calls it as the card does, on the read model of each corpus
 * file (`extractStructuralOnDemand`).
 *
 * Which selection shows a record is read from the file, not from the product:
 * an item, activity or group is selected itself; a resource (load, boundary or
 * connection condition, eccentricity) is looked for on the card of every rooted
 * record that references it, found by walking the file's references back up
 * (a relationship stands for the products it relates).
 *
 * Every record of the row's entity in every carrier file is checked, as in
 * `read.mjs`. For each own attribute, every record that sets it must show that
 * attribute with the file's value; an attribute no fixture sets is unproven.
 * Pass needs every record shown and every value equal.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { cached, storeOf } from '../lib/packages.mjs';
import { equal, normalize, show, verdict } from '../lib/values.mjs';

export const CARD_MODEL = 'apps/viewer/src/components/viewer/properties/structural-card-model.ts';
/** How many references up from a resource the probe looks for a record to select. */
const MAX_HOPS = 4;

/** `{ sections }` (the card model function), or `{ missing }` when the viewer has no card model module. */
function cardModel(ctx) {
  return cached(ctx, 'card:model', async () => {
    const path = join(ctx.root, CARD_MODEL);
    if (!existsSync(path)) return { missing: `the viewer has no structural card model (${CARD_MODEL})` };
    // No tsconfig: the viewer's maps `@ifc-lite/*` to package sources, and the harness measures the built packages.
    const mod = await tsImport(pathToFileURL(path).href, { parentURL: import.meta.url, tsconfig: false });
    if (typeof mod.structuralCardSections !== 'function') throw new Error(`${CARD_MODEL} exports no structuralCardSections()`);
    return { sections: mod.structuralCardSections };
  });
}

/** Record id -> records that reference it, for one file. */
function inverse(ctx, file) {
  return cached(ctx, `card:inverse:${file.path}`, () => {
    const out = new Map();
    const visit = (v, parent) => {
      if (Array.isArray(v)) { for (const x of v) visit(x, parent); return; }
      if (!v || typeof v !== 'object') return;
      if ('ref' in v) { if (!out.has(v.ref)) out.set(v.ref, []); out.get(v.ref).push(parent); return; }
      if ('value' in v) visit(v.value, parent);
    };
    for (const rec of file.step.entities.values()) visit(rec.args, rec);
    return out;
  });
}

const refsIn = (v) => (Array.isArray(v) ? v.flatMap(refsIn) : v && typeof v === 'object' && 'ref' in v ? [v.ref] : []);

/** Rooted records whose card may show `rec`: itself when rooted, else the nearest rooted records referencing it. */
function selections(ctx, file, types, rec) {
  const rooted = (r) => types.get(r?.type)?.rooted;
  if (rooted(rec)) return [rec.id];
  const parents = inverse(ctx, file);
  const out = new Set();
  const seen = new Set([rec.id]);
  let frontier = [rec];
  for (let hop = 0; hop < MAX_HOPS && frontier.length && !out.size; hop++) {
    const next = [];
    for (const r of frontier) {
      for (const p of parents.get(r.id) ?? []) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        if (!rooted(p)) next.push(p);
        else if (p.type.startsWith('IFCREL')) for (const id of refsIn(p.args)) { if (rooted(file.step.get(id))) out.add(id); }
        else out.add(p.id);
      }
    }
    frontier = next;
  }
  return [...out];
}

/** The card sections for one selection in one file, or `{ error }` when the product threw. */
function cardFor(ctx, file, model, expressId) {
  return cached(ctx, `card:${file.path}#${expressId}`, async () => {
    try {
      const store = await storeOf(ctx, file);
      const data = await cached(ctx, `card:data:${file.path}`, async () => ctx.pkgs.parser.extractStructuralOnDemand(store));
      return { sections: model.sections(data, { expressId }, store.schemaVersion) };
    } catch (e) {
      return { error: `card threw: ${e.message}` };
    }
  });
}

/** A card row's value in the form `normalize` gives the file's value. */
function shown(value, step, types) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if ('ref' in value) return normalize({ ref: value.ref }, step, types);
    if ('refs' in value) return value.refs.map((ref) => normalize({ ref }, step, types));
    if ('globalId' in value) return value.globalId;
    if ('globalIds' in value) return value.globalIds;
  }
  return value ?? null;
}

/** The card verdict for one row over every record of its entity in its carrier files. */
async function cardRow(ctx, model, row, carriers) {
  const types = ctx.tables[row.schema].types;
  const problems = [];
  const records = [];
  for (const file of carriers) {
    for (const rec of file.step.of(row.entity)) {
      let section = null;
      for (const id of selections(ctx, file, types, rec)) {
        const card = await cardFor(ctx, file, model, id);
        if (card.error) { problems.push(`${file.path}#${id}: ${card.error}`); continue; }
        section = card.sections.find((s) => s.expressId === rec.id && s.type === row.entity) ?? null;
        if (section) break;
      }
      records.push({ file, rec, section, where: `${file.path}#${rec.id}` });
    }
  }
  if (!records.length) return { status: 'fail', reason: problems.join('; ') || 'no record was checked' };
  const out = [...new Set(problems)];
  const lost = records.filter((r) => !r.section);
  if (lost.length) out.push(`${lost.length} of ${records.length} record(s) on no card, e.g. ${lost[0].where}`);
  const value = (r, attr) => normalize(r.rec.args[row.attributes.indexOf(attr)], r.file.step, types);
  for (const attr of row.own) {
    const setters = records.filter((r) => value(r, attr) !== null);
    if (!setters.length) { out.push(`${attr}: no fixture sets it, so showing it is unproven`); continue; }
    const carded = setters.filter((r) => r.section);
    if (!carded.length) continue; // its records are already reported as on no card
    const cell = (r) => r.section.rows.find((x) => x.attribute === attr);
    const missing = carded.filter((r) => !cell(r));
    if (missing.length) { out.push(`${attr} not shown in ${missing.length} of ${carded.length} record(s), e.g. ${missing[0].where}`); continue; }
    const wrong = carded.filter((r) => !equal(value(r, attr), shown(cell(r).value, r.file.step, types)));
    if (wrong.length) {
      const r = wrong[0];
      out.push(`${attr} wrong in ${wrong.length} of ${carded.length} record(s), e.g. ${r.where}: card ${show(shown(cell(r).value, r.file.step, types))}, file ${show(value(r, attr))}`);
    }
  }
  return verdict(records.length, out, { anyHeld: lost.length < records.length });
}

export default {
  name: 'card:structural-card-sections',
  level: 'card',
  async run(rows, ctx) {
    const model = await cardModel(ctx);
    const out = new Map();
    for (const row of rows) {
      if (model.missing) { out.set(row.id, { status: 'fail', reason: model.missing }); continue; }
      const carriers = ctx.corpus.carriers(row.schema, row.entity);
      if (!carriers.length) { out.set(row.id, ctx.corpus.nothingCarries(row.schema, row.entity)); continue; }
      out.set(row.id, { ...(await cardRow(ctx, model, row, carriers)), evidence: carriers.map((f) => f.path) });
    }
    return out;
  },
};
