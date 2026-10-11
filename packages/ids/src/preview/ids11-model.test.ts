/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS 1.1 PREVIEW nested partOf (#379, draft PR #380) on a real model:
 * `AC20-FZK-Haus.ifc` (an authoring-tool export committed under
 * `apps/viewer/public/_fixtures/`). Its ground floor storey "Erdgeschoss"
 * aggregates six IfcSpace, its roof storey "Dachgeschoss" one. The nested
 * attribute facet on the related storey is what tells the two apart, which
 * IDS 1.0 cannot express.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from '../validation/validator.js';
import { createDataAccessor } from '../bridge/index.js';

const MODEL = join(dirname(fileURLToPath(import.meta.url)), '../../../../apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc');
const PREVIEW = { preview: { ids11: true } } as const;

function spacesOn(storey: string | null, requirementStorey?: string): string {
  const nested = (name: string) => `<attribute><name><simpleValue>Name</simpleValue></name><value><simpleValue>${name}</simpleValue></value></attribute>`;
  const partOf = (name: string | null) => `<partOf relation="IFCRELAGGREGATES">
        <entity><name><simpleValue>IFCBUILDINGSTOREY</simpleValue></name></entity>${name === null ? '' : nested(name)}
      </partOf>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>FZK spaces</title></info>
  <specifications>
    <specification name="spaces" ifcVersion="IFC4">
      <applicability minOccurs="0" maxOccurs="unbounded">
        <entity><name><simpleValue>IFCSPACE</simpleValue></name></entity>
        ${partOf(storey)}
      </applicability>
      ${requirementStorey === undefined ? '' : `<requirements>${partOf(requirementStorey).replace('<partOf ', '<partOf cardinality="required" ')}</requirements>`}
    </specification>
  </specifications>
</ids>`;
}

describe.skipIf(!existsSync(MODEL))('IDS 1.1 preview nested partOf on AC20-FZK-Haus (run `pnpm fixtures` if skipped)', () => {
  async function run(xml: string) {
    const bytes = readFileSync(MODEL);
    const store = await new IfcParser().parseColumnar(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
    const report = await validateIDS(parseIDS(xml, PREVIEW), createDataAccessor(store), {
      modelId: 'AC20-FZK-Haus',
      schemaVersion: String(store.schemaVersion ?? 'IFC4'),
      entityCount: 0,
    }, PREVIEW);
    return report.specificationResults[0]!;
  }

  it('selects only the spaces of the named storey', async () => {
    expect((await run(spacesOn(null))).applicableCount).toBe(7);
    expect((await run(spacesOn('Erdgeschoss'))).applicableCount).toBe(6);
    expect((await run(spacesOn('Dachgeschoss'))).applicableCount).toBe(1);
  }, 60_000);

  it('fails a requirement whose nested facet names the other storey', async () => {
    const wrong = await run(spacesOn('Erdgeschoss', 'Dachgeschoss'));
    expect([wrong.applicableCount, wrong.failedCount]).toEqual([6, 6]);
    const right = await run(spacesOn('Erdgeschoss', 'Erdgeschoss'));
    expect([right.applicableCount, right.passedCount, right.status]).toEqual([6, 6, 'pass']);
  }, 60_000);
});
