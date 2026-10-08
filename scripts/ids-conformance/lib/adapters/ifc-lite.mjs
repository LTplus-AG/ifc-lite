/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The ifc-lite column(s) of the IDS conformance dashboard: `@ifc-lite/ids`
 * from this workspace (built `dist/`, like `scripts/test-ids-corpus.mjs`).
 *
 * `ids11: true` gives the IDS 1.1 PREVIEW column: the same engine with
 * `preview: { ids11: true }` on parse, validate and audit. On the IDS 1.0
 * corpus that differs from the 1.0 column only by the #418 tolerance
 * candidate, so the column shows whether that candidate keeps the verdicts.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * @param {{ ids11?: boolean }} [options]
 * @returns {Promise<import('../matrix.mjs').EngineAdapter>}
 */
export async function createIfcLiteAdapter(options = {}) {
  const idsDist = join(REPO, 'packages/ids/dist/index.js');
  const parserDist = join(REPO, 'packages/parser/dist/index.js');
  const bridgeDist = join(REPO, 'packages/ids/dist/bridge/index.js');
  let ids, parser, bridge;
  try {
    [ids, parser, bridge] = await Promise.all([import(idsDist), import(parserDist), import(bridgeDist)]);
  } catch (err) {
    throw new Error(`@ifc-lite/ids is not built; run \`pnpm turbo build --filter=@ifc-lite/ids...\` first (${err instanceof Error ? err.message : String(err)})`);
  }
  const { version } = JSON.parse(readFileSync(join(REPO, 'packages/ids/package.json'), 'utf8'));
  const preview = options.ids11 ? { ids11: true } : undefined;

  return {
    info: {
      id: options.ids11 ? 'ifc-lite-ids11-preview' : 'ifc-lite',
      name: options.ids11 ? 'ifc-lite (IDS 1.1 preview)' : 'ifc-lite',
      version: `@ifc-lite/ids ${version} (workspace)`,
      licence: 'MPL-2.0',
      source: 'packages/ids in this repository',
      notes: [
        'validate: parseIDS + validateIDS over @ifc-lite/parser; the verdict is the status of the file\'s single specification.',
        'audit: auditIDSDocument; a document with at least one error-severity issue is invalid.',
        ...(options.ids11 ? ['IDS 1.1 preview flag on parse, validate and audit (#418 tolerance candidate applies to simple values).'] : []),
      ],
    },
    async validate({ id, idsPath, ifcPath }) {
      const bytes = readFileSync(ifcPath);
      const store = await new parser.IfcParser().parseColumnar(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      );
      const document = ids.parseIDS(readFileSync(idsPath, 'utf8'), { preview });
      const report = await ids.validateIDS(document, bridge.createDataAccessor(store), {
        modelId: id,
        schemaVersion: String(store.schemaVersion ?? 'IFC4'),
        entityCount: 0,
      }, { preview });
      if (report.specificationResults.length !== 1) {
        throw new Error(`expected one specification, got ${report.specificationResults.length}`);
      }
      const status = report.specificationResults[0].status;
      if (status !== 'pass' && status !== 'fail') throw new Error(`unexpected status ${status}`);
      return status;
    },
    async audit({ idsPath }) {
      const report = await ids.auditIDSDocument(readFileSync(idsPath, 'utf8'), { preview });
      return report.issues.some((issue) => issue.severity === 'error') ? 'invalid' : 'valid';
    },
  };
}
