/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Child process behind `thatopen-components.mjs`: loads the
 * `@thatopen/components` IDS engine from the install directory given as
 * argv[2] and answers IPC requests:
 *   { seq, kind: 'info' }                         -> EngineInfo
 *   { seq, kind: 'validate', idsPath, ifcPath }   -> { applicable, failed }
 * Errors are sent back as `{ seq, error }`; the parent turns them into
 * `error` cells.
 *
 * Headless shims, local to this process: `Worker` from the `web-worker`
 * package for the fragments worker, and a `window` with a fixed 1024x768
 * screen, which the fragments view manager reads to size its
 * level-of-detail budget. Neither is consulted by the IDS logic.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
if (!root || !process.send) throw new Error('thatopen-process.mjs is started by thatopen-components.mjs');

const require = createRequire(join(root, 'package.json'));
const load = (/** @type {string} */ name) => import(pathToFileURL(require.resolve(name)).href);
const version = (/** @type {string} */ name) => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

globalThis.Worker ??= (await load('web-worker')).default;
globalThis.window ??= { innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1, screen: { width: 1024, height: 768 } };
const OBC = await load('@thatopen/components');

const components = new OBC.Components();
const fragments = components.get(OBC.FragmentsManager);
fragments.init(pathToFileURL(join(root, 'node_modules/@thatopen/fragments/dist/Worker/worker.mjs')).href);
const loader = components.get(OBC.IfcLoader);
await loader.setup({ autoSetWasm: false, wasm: { path: `${join(root, 'node_modules/web-ifc')}/`, absolute: true } });
const idsComponent = components.get(OBC.IDSSpecifications);
let serial = 0;

const INFO = {
  id: 'thatopen-components',
  name: '@thatopen/components (IDS module)',
  version: `${version('@thatopen/components')} (fragments ${version('@thatopen/fragments')}, web-ifc ${version('web-ifc')})`,
  licence: 'MIT (web-ifc: MPL-2.0)',
  source: 'https://www.npmjs.com/package/@thatopen/components',
  notes: [
    'validate: IfcLoader converts the IFC, IDSSpecifications loads the IDS, the single specification is tested; the engine reports one pass/fail per applicable element.',
    'The adapter derives the specification verdict with IDS 1.0 cardinality: fail if any applicable element fails, if fewer elements apply than minOccurs (default 1), or if maxOccurs="0" and any element applies. Applicable elements are collected with the engine\'s own applicability facets, as its test() does.',
    'IfcLoader runs with its default import settings. Entities its importer does not convert (for example IfcTaskTime, which is not a product) are invisible to the engine, so a specification on them finds nothing applicable.',
    'audit: not offered by the engine; invalid- cases are n/a.',
  ],
};

/** @param {string} idsPath @param {string} ifcPath */
async function validate(idsPath, ifcPath) {
  const modelId = `case-${serial++}`;
  const model = await loader.load(new Uint8Array(readFileSync(ifcPath)), false, modelId);
  try {
    idsComponent.list.clear();
    const specs = idsComponent.load(readFileSync(idsPath, 'utf8'));
    if (specs.length !== 1) throw new Error(`expected one specification, got ${specs.length}`);
    const modelIds = [new RegExp(`^${modelId}$`)];
    /** @type {Record<string, Set<number>>} */
    const applicableItems = {};
    await Promise.all([...specs[0].applicability].map((facet) => facet.getEntities(modelIds, applicableItems)));
    const applicable = Object.values(applicableItems).reduce((n, set) => n + set.size, 0);
    let failed = 0;
    for (const [, perModel] of await specs[0].test(modelIds)) {
      for (const [, item] of perModel) if (!item.pass) failed++;
    }
    return { applicable, failed };
  } finally {
    await fragments.core.disposeModel(model.modelId);
  }
}

process.on('message', async (/** @type {any} */ msg) => {
  try {
    const result = msg.kind === 'info' ? INFO : await validate(msg.idsPath, msg.ifcPath);
    process.send?.({ seq: msg.seq, result });
  } catch (err) {
    process.send?.({ seq: msg.seq, error: err instanceof Error ? err.message : String(err) });
  }
});
