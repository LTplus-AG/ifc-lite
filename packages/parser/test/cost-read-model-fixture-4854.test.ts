/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ColumnarParser } from '../src/columnar-parser.js';
import { evaluateCostItem } from '../src/cost-evaluator.js';
import { extractCostOnDemand } from '../src/cost-extractor.js';
import { StepTokenizer } from '../src/tokenizer.js';

const FIXTURE_URL = new URL('../../../tests/models/cost/buildingsmart-cost-composition.ifc', import.meta.url);
const FIXTURE_PATH = fileURLToPath(FIXTURE_URL);
const HAS_FIXTURE = existsSync(FIXTURE_PATH);

if (!HAS_FIXTURE) {
  console.warn('skip: canonical cost fixture missing — run `pnpm fixtures`');
}

async function parseFixture() {
  const bytes = new Uint8Array(readFileSync(FIXTURE_PATH));
  const refs = [...new StepTokenizer(bytes).scanEntitiesFast()].map(ref => ({
    expressId: ref.expressId, type: ref.type, byteOffset: ref.offset,
    byteLength: ref.length, lineNumber: ref.line,
  }));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new ColumnarParser().parseLite(buffer, refs, {});
}

describe('#4854 redistributable canonical cost fixture', () => {
  it.skipIf(!HAS_FIXTURE)('matches the independently published buildingSMART composition oracle', async () => {
    const fixtureText = readFileSync(FIXTURE_PATH, 'utf8');
    const rootGlobalIds = [...fixtureText.matchAll(
      /#\d+=IFC(?:PROJECT|WALL|TASK|COSTITEM|COSTSCHEDULE|REL[A-Z]+)\('([^']+)'/g,
    )].map(match => match[1]);
    expect(rootGlobalIds.length).toBe(14);
    expect(rootGlobalIds.every(id => /^[0-3][0-9A-Za-z_$]{21}$/.test(id))).toBe(true);
    expect(new Set(rootGlobalIds).size).toBe(rootGlobalIds.length);
    const extraction = extractCostOnDemand(await parseFixture());
    const scaffolding = extraction.CostItems.find(item => item.Name === 'Scaffolding');
    const brick = extraction.CostItems.find(item => item.Name === 'Brick wall');
    const total = extraction.CostItems.find(item => item.Name === 'External wall total');
    const shared = extraction.CostItems.find(item => item.Name === 'Shared rate audit');

    expect(extraction.SchemaVersion).toBe('IFC4');
    expect(extraction.Currency).toBe('GBP');
    expect(extraction.Diagnostics).toEqual([]);
    expect(extraction.CostSchedules[0]).toMatchObject({ Name: 'Canonical budget' });
    // #10 is the IfcWall, #11 the IfcTask bound through the same
    // IfcRelAssignsToControl (#62): productExpressIds is products-only (#4877),
    // so only the wall appears; the task assignment is pinned via #62 below.
    expect(total).toMatchObject({ CostValues: [38], childGlobalIds: [
      '3JYq7Z8qH3nP9JjM4fLg2A', '0JYq7Z8qH3nP9JjM4fLg2B',
    ], productExpressIds: [10] });
    expect(scaffolding?.CostQuantities).toEqual([20]);
    expect(brick?.CostQuantities).toEqual([21]);
    expect(extraction.CostQuantities).toEqual(expect.arrayContaining([
      expect.objectContaining({ Type: 'IfcQuantityArea', AreaValue: '100.' }),
      expect.objectContaining({ Type: 'IfcQuantityVolume', VolumeValue: '100.' }),
    ]));
    const scaffoldingSharedValue = scaffolding?.costValues?.[0];
    const sharedCostValue = shared?.costValues?.[0];
    expect(scaffoldingSharedValue).toBeDefined();
    expect(sharedCostValue).toBeDefined();
    expect(scaffoldingSharedValue).toBe(sharedCostValue);
    expect(extraction.Relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ Type: 'IfcRelAssignsToControl', RelatingControl: 50, RelatedObjects: [42] }),
      expect.objectContaining({ Type: 'IfcRelAssignsToControl', RelatingControl: 42, RelatedObjects: [10, 11] }),
      expect.objectContaining({ Type: 'IfcRelAssignsToProduct', RelatingProduct: 10, RelatedObjects: [40] }),
      expect.objectContaining({ Type: 'IfcRelAssignsToProcess', RelatingProcess: 11, RelatedObjects: [42] }),
    ]));

    expect(evaluateCostItem(extraction, scaffolding?.expressId ?? -1)).toMatchObject({ Amount: '800', Currency: 'GBP' });
    expect(evaluateCostItem(extraction, brick?.expressId ?? -1)).toMatchObject({ Amount: '1300', Currency: 'GBP' });
    expect(evaluateCostItem(extraction, total?.expressId ?? -1)).toMatchObject({ Amount: '2250', Currency: 'GBP' });
  });
});
