/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6643: authored IFC measure declarations survive actual SDK mutation and STEP export/reparse. */
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { EntityNode } from '@ifc-lite/query';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { createHeadlessMutateAdapter } from './headless-mutate.js';
import { MutateNamespace } from './namespaces/mutate.js';
const SOURCE = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('original-typed.ifc','2026-10-02T00:00:00',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCWALL('0000000000000000000001',$,'Original wall',$,$,$,$,$,.NOTDEFINED.);\nENDSEC;\nEND-ISO-10303-21;";
const parse = (source: string) => new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer, { disableWorkerScan: true });
describe('typed SDK mutations #6643', () => {
  it('retains numeric measure declarations at fractional and integer values; legacy inference remains unchanged', async () => {
    const store = await parse(SOURCE); const view = new MutablePropertyView(store.properties, 'm');
    const sdk = new MutateNamespace({ mutate: createHeadlessMutateAdapter(() => view, ref => ref.modelId === 'm' && ref.expressId === 1 ? null : 'invalid fixture ref') });
    const ref = { modelId: 'm', expressId: 1 };
    sdk.setProperty(ref, 'Pset_WallCommon', 'ThermalTransmittance', 0.25, 'IfcThermalTransmittanceMeasure');
    sdk.setProperty(ref, 'Pset_Test', 'WholeMeasure', 1, 'IfcThermalTransmittanceMeasure');
    sdk.setProperty(ref, 'Pset_Test', 'Count', 1); sdk.setProperty(ref, 'Pset_Test', 'Enabled', true);
    sdk.setProperty(ref, 'Pset_Test', 'Description', 'Original typed text', 'IfcText');
    const exported = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });
    const reopened = await parse(new TextDecoder().decode(exported.content));
    const psets = new EntityNode(reopened, 1).properties();
    const property = (pset: string, name: string) => psets.find(p => p.name === pset)?.properties.find(p => p.name === name);
    expect(property('Pset_WallCommon', 'ThermalTransmittance')).toMatchObject({ value: 0.25, dataType: 'IFCTHERMALTRANSMITTANCEMEASURE' });
    expect(property('Pset_Test', 'WholeMeasure')).toMatchObject({ value: 1, dataType: 'IFCTHERMALTRANSMITTANCEMEASURE' });
    expect(property('Pset_Test', 'Count')).toMatchObject({ value: 1, dataType: 'IFCINTEGER' });
    expect(property('Pset_Test', 'Enabled')).toMatchObject({ value: true, dataType: 'IFCBOOLEAN' });
    expect(property('Pset_Test', 'Description')).toMatchObject({ value: 'Original typed text', dataType: 'IFCTEXT' });
  });
  it('rejects invalid declarations before creating any overlay writes', async () => {
    const store = await parse(SOURCE); const view = new MutablePropertyView(store.properties, 'm');
    const sdk = new MutateNamespace({ mutate: createHeadlessMutateAdapter(() => view, () => null) });
    const ref = { modelId: 'm', expressId: 1 };
    for (const [value, dataType] of [[1, 'IfcWall'], [1, 'IfcReal);ENDSEC;'], ['1', 'IfcThermalTransmittanceMeasure'], [-1, 'IfcPositiveLengthMeasure'], [Infinity, 'IfcReal'], ['x'.repeat(256), 'IfcLabel']] as const) {
      expect(() => sdk.setProperty(ref, 'Pset_Test', 'Invalid', value, dataType)).toThrow();
    }
    expect(view.getMutations()).toHaveLength(0);
  });
});
