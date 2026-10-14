/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IfcParser, scanIfcEntities } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter, exportToStep } from './step-exporter.js';

const source = readFileSync(new URL('../../../tests/fixtures/step-apostrophe-pair.ifc', import.meta.url), 'utf8');
const parse = (text: string) => new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });

describe('#7541 real partial source cannot become an apparently successful STEP export', () => {
  it('refuses sync and async exporters before extraction or progress', async () => {
    const store = await parse(source);
    expect(Array.from(store.entityIndex.byId.keys())).toEqual([1, 2, 3, 21, 22, 31]);
    expect(store.malformedRecordCount).toBe(1);
    const progress: string[] = [];
    expect(() => exportToStep(store)).toThrow(/source index incomplete/);
    expect(() => new StepExporter(store).export({ schema: 'IFC4', onProgress: p => { progress.push(p.phase); } })).toThrow(/source index incomplete/);
    await expect(async () => new StepExporter(store).exportAsync({ schema: 'IFC4', onProgress: p => { progress.push(p.phase); } })).rejects.toThrow(/source index incomplete/);
    expect(progress).toEqual([]);
  });

  it('preserves valid doubled quotes, actual Name edits and unknown-provenance compatibility', async () => {
    const store = await parse(source.replace("it's", "it''s").replace("Bob's", "Bob''s"));
    expect(store.malformedRecordCount).toBe(0);
    const view = new MutablePropertyView(null, 'authored');
    view.setAttribute(21, 'Name', 'Authored edit', 'W2');
    const exported = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
    expect(new TextDecoder().decode(exported)).toContain("'Authored edit'");
    const scan = await scanIfcEntities(Uint8Array.from(exported).buffer, { disableWorkerScan: true });
    expect(scan.entityRefs.map(ref => ref.expressId)).toEqual([1, 2, 3, 20, 21, 22, 30, 31]);
    expect(scan.malformedRecordCount).toBe(0);
    const { malformedRecordCount: observed, ...unobserved } = store;
    expect(observed).toBe(0);
    expect(exportToStep(unobserved)).toContain("#21=IFCWALL");
  });
});
