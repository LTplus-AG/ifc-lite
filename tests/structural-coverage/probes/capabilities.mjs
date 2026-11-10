/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Probes for capability rows that are cheap to measure today.
 *
 * `cap/physical-analytical-link-read`: for each link in the corpus from a
 * physical product to a structural item (IfcRelAssignsToProduct, or the IFC2X3
 * IfcRelConnectsStructuralElement), the item's read-model object must name the
 * physical product's GlobalId in one of its fields. The probe does not
 * prescribe the field name; it asserts the value.
 *
 * `cap/docs-page`: a `docs/guide/*structural*.md` page names every IFC4 entity
 * of the catalogue.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStore } from '../lib/packages.mjs';
import { verdict } from '../lib/values.mjs';

const MAX_LINKS_PER_FILE = 25;

/** [structural item id, physical product id] pairs the file declares. */
function physicalLinks(step) {
  const structural = (e) => e && /^IFCSTRUCTURAL(CURVE|SURFACE|POINT)(MEMBER|CONNECTION)/.test(e.type);
  const pairs = [];
  for (const rel of step.of('IFCRELASSIGNSTOPRODUCT')) {
    const product = step.get(rel.args[6]);
    if (!product || structural(product)) continue;
    for (const r of rel.args[4] ?? []) if (structural(step.get(r))) pairs.push([r.ref, product.id]);
  }
  for (const rel of step.of('IFCRELCONNECTSSTRUCTURALELEMENT')) {
    if (structural(step.get(rel.args[5]))) pairs.push([rel.args[5].ref, rel.args[4]?.ref]);
  }
  return pairs;
}

const mentions = (info, guid) => Object.values(info).some((v) => v === guid || (Array.isArray(v) && v.includes(guid)));

const linkRead = {
  name: 'capability:physical-analytical-link-read',
  level: 'capability',
  covers: (row) => row.id === 'cap/physical-analytical-link-read',
  async run(rows, ctx) {
    const files = ctx.corpus.files.filter((f) => physicalLinks(f.step).length);
    if (!files.length) {
      return new Map(rows.map((r) => [r.id, ctx.corpus.absent.length
        ? { status: 'skip', reason: 'offline: no present corpus file carries a physical-to-structural link' }
        : { status: 'fail', reason: 'no corpus file carries a physical-to-structural link' }]));
    }
    const problems = [];
    let checked = 0;
    let anyHeld = false;
    for (const file of files) {
      const x = ctx.pkgs.parser.extractStructuralOnDemand(await parseStore(ctx.pkgs, file.bytes));
      const byId = new Map([...x.members, ...x.connections].map((i) => [i.expressId, i]));
      for (const [itemId, productId] of physicalLinks(file.step).slice(0, MAX_LINKS_PER_FILE)) {
        checked++;
        const guid = file.step.get(productId)?.args[0];
        const info = byId.get(itemId);
        if (!info) problems.push(`${file.path}#${itemId}: item not in the read model`);
        else if (!mentions(info, guid)) problems.push(`${file.path}#${itemId}: no field names physical ${guid}`);
        else anyHeld = true;
      }
    }
    const result = { ...verdict(checked, problems, { anyHeld }), evidence: files.map((f) => f.path) };
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
      const missing = ctx.rows.filter((r) => r.kind === 'entity' && r.schema === 'IFC4' && !text.includes(r.entity)).map((r) => r.entity);
      result = missing.length
        ? { status: 'partial', reason: `${pages.join(', ')} does not name ${missing.length} IFC4 entities, e.g. ${missing.slice(0, 5).join(', ')}` }
        : { status: 'pass', evidence: pages };
    }
    return new Map(rows.map((r) => [r.id, result]));
  },
};

export default [linkRead, docsPage];
