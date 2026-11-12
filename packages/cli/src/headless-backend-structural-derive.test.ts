/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9668: `bim.store.planStructuralDerivation` and `deriveStructuralAnalysisModel`
 * reach the derivation through the CLI's headless backend, the way `ifc-lite
 * eval` and scripts call them, and the written model links back.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IfcParser, extractStructuralOnDemand, structuralCounterparts } from '@ifc-lite/parser';
import { createBimContext } from '@ifc-lite/sdk';
import { HeadlessBackend } from './headless-backend.js';

const SAMPLE = fileURLToPath(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));

async function parse(bytes: Uint8Array) {
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
}

describe.skipIf(!existsSync(SAMPLE))('bim.store structural derivation (#9668)', () => {
  it('plans without writing, derives once, and refuses the second run', async () => {
    const store = await parse(new Uint8Array(readFileSync(SAMPLE)));
    const backend = new HeadlessBackend(store, 'hello-wall.ifc');
    // The backend's own surface, so a host that never wires the factory fails here.
    expect(typeof backend.store.planStructuralDerivation).toBe('function');
    expect(typeof backend.store.deriveStructuralAnalysisModel).toBe('function');
    const bim = createBimContext({ backend });

    const plan = bim.store.planStructuralDerivation('default', { tolerance: 0.1 });
    expect(plan.options.tolerance).toBe(0.1);
    expect(plan.report.counts.surfaceMembers).toBe(1);
    expect(extractStructuralOnDemand(store).hasStructural).toBe(false);

    const { analysisModel, report } = bim.store.deriveStructuralAnalysisModel('default');
    expect(analysisModel.modelId).toBe('default');
    expect(report.counts.surfaceMembers).toBe(1);
    expect(() => bim.store.deriveStructuralAnalysisModel('default')).toThrow(/no members/);

    const written = await parse(new TextEncoder().encode(bim.export.ifc(undefined, { schema: 'IFC4' }) as string));
    const data = extractStructuralOnDemand(written);
    expect(data.analysisModels).toHaveLength(1);
    expect(structuralCounterparts(data, data.members[0].expressId)?.side).toBe('physical');
  });
});
