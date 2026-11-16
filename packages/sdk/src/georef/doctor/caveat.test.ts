/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openModel } from '../../headless.js';
import type { GeorefPlannedFix } from './types.js';
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../../../georef-check/fixtures/${name}.ifc`, import.meta.url)));
const open = (bytes: Uint8Array) => openModel(bytes, { disableWorkerScan: true });
const fix = (plan: { fixes: GeorefPlannedFix[] }, id: string) => plan.fixes.find((f) => f.id === id)!;
// PR #10537: the mutation oracle witnesses only the caveat safety invariant.
describe('fix() re-checks the safety rules of a plan it is handed', () => {
  it('refuses a fix marked ready that still has an open value, or a checker caveat, and writes nothing', async () => {
    const model = await open(fixture('double-site-placement'));
    try {
      const plan = model.bim.georef.planFixes(await model.bim.georef.check());
      expect(fix(plan, 'MAP_POSITION_APPLIED_TWICE.2').status).toBe('review');
      expect(model.bim.georef.fix(plan).applied).toEqual([]);
      const caveated = plan.fixes.map((f) => (f.id === 'MAP_POSITION_APPLIED_TWICE.2' ? { ...f, status: 'ready' as const } : f));
      expect(() => model.bim.georef.fix({ fixes: caveated })).toThrow(/uncertain/);
      const open_ = { ...fix(plan, 'MAP_POSITION_APPLIED_TWICE.2'), caveat: undefined, status: 'ready' as const, write: { via: 'georef.update' as const, input: { MapConversion: { Eastings: null as unknown as number } } } };
      expect(() => model.bim.georef.fix({ fixes: [open_] })).toThrow(/still open/);
      expect(model.bim.georef.get().pending).toBe(false);
    } finally { model.close(); }
  });
});

