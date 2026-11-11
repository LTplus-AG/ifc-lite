/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Probes for capability rows that are cheap to measure today.
 *
 * `cap/physical-analytical-link-read`: for each link in the corpus from a
 * physical product to a structural item (IfcRelAssignsToProduct, or the IFC2X3
 * IfcRelConnectsStructuralElement), the item's read-model object must name the
 * physical product via physicalElementIds: exactly the express ids the file
 * links to that item, no duplicate, each an IfcElement by its declared class
 * with the fixture's GlobalId. Every other structural member and connection
 * the product reads, in any file, must name no physical element.
 *
 * `cap/docs-page`: a `docs/guide/*structural*.md` page (lowercase `structural`,
 * case-sensitive, the same rule as the CI path filter) names every IFC4 entity
 * of the catalogue.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verdict } from '../lib/values.mjs';
import { storeOf } from '../lib/packages.mjs';
import { extractionEntry } from './read.mjs';

/** Whether a type name, in STEP UPPERCASE or PascalCase, is an IfcElement subtype in `table`. */
const isElement = (table, type) => table.chain(table.types.get(String(type ?? '').toUpperCase())?.name ?? '').includes('IfcElement');

/**
 * Distinct [structural item id, physical product id] pairs the file declares.
 * The physical end must be an IfcElement (what IFC2X3
 * IfcRelConnectsStructuralElement.RelatingElement declares), so an item
 * assigned to a storey or an action assigned to a member is not a link.
 */
function physicalLinks(step, table) {
  const structural = (e) => e && /^IFCSTRUCTURAL(CURVE|SURFACE|POINT)(MEMBER|CONNECTION)/.test(e.type);
  const element = (e) => e && isElement(table, e.type);
  const pairs = new Map();
  const add = (item, product) => pairs.set(`${item},${product}`, [item, product]);
  for (const rel of step.of('IFCRELASSIGNSTOPRODUCT')) {
    const product = step.get(rel.args[6]);
    if (!product) continue;
    for (const r of rel.args[4] ?? []) {
      const related = step.get(r);
      if (structural(related) && element(product)) add(r.ref, product.id);
      else if (structural(product) && element(related)) add(product.id, related.id);
    }
  }
  for (const rel of step.of('IFCRELCONNECTSSTRUCTURALELEMENT')) {
    if (structural(step.get(rel.args[5])) && element(step.get(rel.args[4]))) add(rel.args[5].ref, rel.args[4].ref);
  }
  return [...pairs.values()];
}

/**
 * Whether the read model's `physicalElementIds` are exactly the elements the
 * file links to the item: no duplicate, each the referenced record (express
 * id), an IfcElement by its declared class, with the fixture's GlobalId.
 */
function linkedElements(info, declared, store, table, step) {
  const ids = info.physicalElementIds;
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.length !== declared.size) return false;
  return ids.every((id) => declared.has(id)
    // The declared class (getTypeName may answer with a coalesced IfcTypeEnum
    // family); a store without the exact accessor fails the link.
    && isElement(table, store.entities.getExactTypeName?.(id))
    && store.entities.getGlobalId(id) === step.get(id)?.args[0]);
}

/** An item the file links to nothing must name no physical element. */
const noElements = (info) => info.physicalElementIds === undefined || (Array.isArray(info.physicalElementIds) && !info.physicalElementIds.length);

const linkRead = {
  name: 'capability:physical-analytical-link-read',
  level: 'capability',
  covers: (row) => row.id === 'cap/physical-analytical-link-read',
  async run(rows, ctx) {
    // A file whose schema has no catalogue section (IFC4X2) has no type table to judge it by.
    const files = ctx.corpus.files.filter((f) => ctx.tables[f.schema]).map((f) => [f, physicalLinks(f.step, ctx.tables[f.schema]), ctx.tables[f.schema]]);
    const linked = files.filter(([, links]) => links.length);
    if (!linked.length) return new Map(rows.map((r) => [r.id, ctx.corpus.nothingFound('carries a physical-to-structural link')]));
    const problems = [];
    const counts = [];
    for (const [file, links, table] of files) {
      // A file the product cannot extract proves nothing; with links it is a problem of its own.
      const { ix, error } = await extractionEntry(ctx, file);
      if (error && links.length) problems.push(`${file.path}: ${error}`);
      const count = { path: file.path, checked: links.length, held: 0 };
      if (links.length) counts.push(count);
      if (!ix) continue;
      const declared = new Map();
      for (const [itemId, productId] of links) {
        if (!declared.has(itemId)) declared.set(itemId, new Set());
        declared.get(itemId).add(productId);
      }
      for (const [id, hit] of ix.byId) {
        if (hit.family === 'item' && !declared.has(id) && !noElements(hit.info)) problems.push(`${file.path}#${id}: the file links no physical element to this item, but physicalElementIds names ${JSON.stringify(hit.info.physicalElementIds)}`);
      }
      if (!links.length) continue;
      const store = await storeOf(ctx, file);
      for (const [itemId, productId] of links) {
        const guid = file.step.get(productId).args[0];
        const hit = ix.byId.get(itemId);
        const info = hit?.family === 'item' ? hit.info : undefined;
        // physicalLinks only pairs records the file holds, so product is always present.
        if (typeof guid !== 'string') problems.push(`${file.path}#${itemId}: the physical element has no GlobalId`);
        else if (!info) problems.push(`${file.path}#${itemId}: item not in the read model`);
        else if (!linkedElements(info, declared.get(itemId), store, table, file.step)) problems.push(`${file.path}#${itemId}: physicalElementIds ${JSON.stringify(info.physicalElementIds)} is not exactly the file's links ${JSON.stringify([...declared.get(itemId)])}`);
        else count.held++;
      }
    }
    const checked = counts.reduce((n, c) => n + c.checked, 0);
    const result = { ...verdict(checked, problems, { anyHeld: counts.some((c) => c.held) }), counts, evidence: linked.map(([f]) => f.path) };
    return new Map(rows.map((r) => [r.id, result]));
  },
};

const docsPage = {
  name: 'capability:docs-page',
  level: 'capability',
  covers: (row) => row.id === 'cap/docs-page',
  async run(rows, ctx) {
    const dir = join(ctx.root, 'docs/guide');
    const pages = existsSync(dir) ? readdirSync(dir).filter((f) => f.includes('structural') && f.endsWith('.md')).sort() : [];
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
