/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Probes for capability rows that are cheap to measure today.
 *
 * `cap/physical-analytical-link-read`: for each link in the corpus from a
 * physical product to a structural item (IfcRelAssignsToProduct, or the IFC2X3
 * IfcRelConnectsStructuralElement), the item's read-model object must name the
 * physical product via physicalElementIds. Each express id must resolve to
 * an IfcElement subtype in the parsed store whose GlobalId the file links to
 * that item, and the linked product's GlobalId must be among them.
 *
 * `cap/docs-page`: a `docs/guide/*structural*.md` page names every IFC4 entity
 * of the catalogue.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verdict } from '../lib/values.mjs';
import { storeOf } from '../lib/packages.mjs';
import { extractionOrProblem } from './read.mjs';

/** [structural item id, physical product id] pairs the file declares. */
function physicalLinks(step) {
  const structural = (e) => e && /^IFCSTRUCTURAL(CURVE|SURFACE|POINT)(MEMBER|CONNECTION)/.test(e.type);
  const pairs = [];
  for (const rel of step.of('IFCRELASSIGNSTOPRODUCT')) {
    const product = step.get(rel.args[6]);
    if (!product) continue;
    for (const r of rel.args[4] ?? []) {
      const related = step.get(r);
      if (structural(related) && !structural(product)) pairs.push([r.ref, product.id]);
      else if (structural(product) && related && !structural(related)) pairs.push([product.id, related.id]);
    }
  }
  for (const rel of step.of('IFCRELCONNECTSSTRUCTURALELEMENT')) {
    if (structural(step.get(rel.args[5]))) pairs.push([rel.args[5].ref, rel.args[4]?.ref]);
  }
  return pairs;
}

/** Each id resolves to an IfcElement whose GlobalId the file links to this item, and `guid` is among them. */
function linkedElement(info, guid, declared, store, table) {
  const ids = info.physicalElementIds;
  if (!Array.isArray(ids) || !ids.length) return false;
  const guids = [];
  for (const id of ids) {
    if (!Number.isSafeInteger(id)) return false;
    const type = store.entities.getTypeName(id);
    if (!table.chain(type).includes('IfcElement')) return false;
    const value = store.entities.getGlobalId(id);
    if (!value) return false;
    guids.push(value);
  }
  return guids.includes(guid) && guids.every((g) => declared.has(g));
}

const linkRead = {
  name: 'capability:physical-analytical-link-read',
  level: 'capability',
  covers: (row) => row.id === 'cap/physical-analytical-link-read',
  async run(rows, ctx) {
    const linked = ctx.corpus.files.map((f) => [f, physicalLinks(f.step)]).filter(([, links]) => links.length);
    if (!linked.length) return new Map(rows.map((r) => [r.id, ctx.corpus.nothingFound('carries a physical-to-structural link')]));
    const problems = [];
    const counts = [];
    let checked = 0;
    let anyHeld = false;
    for (const [file, links] of linked) {
      const ix = await extractionOrProblem(ctx, file, problems);
      const count = { path: file.path, checked: links.length, held: 0 };
      counts.push(count);
      if (!ix) { checked += links.length; continue; }
      const store = await storeOf(ctx, file);
      const declared = new Map();
      for (const [itemId, productId] of links) {
        if (!declared.has(itemId)) declared.set(itemId, new Set());
        declared.get(itemId).add(file.step.get(productId)?.args[0]);
      }
      for (const [itemId, productId] of links) {
        checked++;
        const product = file.step.get(productId);
        const guid = product?.args[0];
        const hit = ix.byId.get(itemId);
        const info = hit?.family === 'item' ? hit.info : undefined;
        if (!product) problems.push(`${file.path}#${itemId}: the link names no physical element the file holds`);
        else if (typeof guid !== 'string') problems.push(`${file.path}#${itemId}: the physical element has no GlobalId`);
        else if (!info) problems.push(`${file.path}#${itemId}: item not in the read model`);
        else if (!linkedElement(info, guid, declared.get(itemId), store, ctx.tables[file.schema])) problems.push(`${file.path}#${itemId}: physicalElementIds does not resolve to physical ${guid} and only the file's links`);
        else { anyHeld = true; count.held++; }
      }
    }
    const result = { ...verdict(checked, problems, { anyHeld }), counts, evidence: linked.map(([f]) => f.path) };
    return new Map(rows.map((r) => [r.id, result]));
  },
};

const docsPage = {
  name: 'capability:docs-page',
  level: 'capability',
  covers: (row) => row.id === 'cap/docs-page',
  async run(rows, ctx) {
    const dir = join(ctx.root, 'docs/guide');
    const pages = existsSync(dir) ? readdirSync(dir).filter((f) => /structural/i.test(f) && f.endsWith('.md')).sort() : [];
    let result;
    if (!pages.length) result = { status: 'fail', reason: 'no docs/guide/*structural*.md page' };
    else {
      const text = pages.map((p) => readFileSync(join(dir, p), 'utf8')).join('\n');
      // Whole words: naming IfcStructuralCurveMemberVarying must not count as naming IfcStructuralCurveMember.
      const named = new Set(text.match(/\bIfc[A-Za-z0-9]+\b/g) ?? []);
      const missing = ctx.rows.filter((r) => r.kind === 'entity' && r.schema === 'IFC4' && !named.has(r.entity)).map((r) => r.entity);
      result = missing.length
        ? { status: 'partial', reason: `${pages.join(', ')} does not name ${missing.length} IFC4 entities, e.g. ${missing.slice(0, 5).join(', ')}` }
        : { status: 'pass', evidence: pages };
    }
    return new Map(rows.map((r) => [r.id, result]));
  },
};

export default [linkRead, docsPage];
