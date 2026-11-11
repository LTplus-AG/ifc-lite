/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { IfcParser, extractStructuralOnDemand } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { createStructuralStoreBackend } from './store-structural-backend.js';
import { StoreNamespace } from './index.js';
import type { BimBackend } from './types.js';

// #9764: existing public methods must remain overridable as methods by SDK subclasses.
class CustomStoreNamespace extends StoreNamespace {
  override addStructuralAnalysisModel(...args: Parameters<StoreNamespace['addStructuralAnalysisModel']>) {
    return super.addStructuralAnalysisModel(args[0], { ...args[1], Name: `Custom ${args[1].Name}` });
  }
  override addStructuralCurveMember(...args: Parameters<StoreNamespace['addStructuralCurveMember']>) { return super.addStructuralCurveMember(...args); }
  override addStructuralPointConnection(...args: Parameters<StoreNamespace['addStructuralPointConnection']>) { return super.addStructuralPointConnection(...args); }
  override addStructuralSurfaceMember(...args: Parameters<StoreNamespace['addStructuralSurfaceMember']>) { return super.addStructuralSurfaceMember(...args); }
  override addStructuralCurveConnection(...args: Parameters<StoreNamespace['addStructuralCurveConnection']>) { return super.addStructuralCurveConnection(...args); }
  override addStructuralSurfaceConnection(...args: Parameters<StoreNamespace['addStructuralSurfaceConnection']>) { return super.addStructuralSurfaceConnection(...args); }
  override addStructuralLoadGroup(...args: Parameters<StoreNamespace['addStructuralLoadGroup']>) { return super.addStructuralLoadGroup(...args); }
  override addStructuralPointAction(...args: Parameters<StoreNamespace['addStructuralPointAction']>) { return super.addStructuralPointAction(...args); }
  override addStructuralLinearAction(...args: Parameters<StoreNamespace['addStructuralLinearAction']>) { return super.addStructuralLinearAction(...args); }
  override connectStructuralMemberToConnection(...args: Parameters<StoreNamespace['connectStructuralMemberToConnection']>) { return super.connectStructuralMemberToConnection(...args); }
  override connectStructuralActivityToItem(...args: Parameters<StoreNamespace['connectStructuralActivityToItem']>) { return super.connectStructuralActivityToItem(...args); }
  override assignToStructuralGroup(...args: Parameters<StoreNamespace['assignToStructuralGroup']>) { return super.assignToStructuralGroup(...args); }
}

const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',#4,'P',$,$,$,$,(#7),#9);
#2=IFCPERSON($,'Author',$,$,$,$,$,$);
#3=IFCORGANIZATION($,'Org',$,$,$);
#4=IFCOWNERHISTORY(#10,#11,$,.ADDED.,0,$,$,0);
#10=IFCPERSONANDORGANIZATION(#2,#3,$);
#11=IFCAPPLICATION(#3,'1','Test','Test');
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCAXIS2PLACEMENT3D(#5,$,$);
#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#6,$);
#9=IFCUNITASSIGNMENT((#91));
#91=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCLOCALPLACEMENT($,#6);
#30=IFCBUILDINGSTOREY('0storey000000000000000',#4,'Level 0',$,$,#20,$,$,.ELEMENT.,0.);
#31=IFCRELAGGREGATES('0aggr00000000000000000',#4,$,$,#1,(#30));
ENDSEC;
END-ISO-10303-21;`;


describe('SDK structural activities and results (#9668)', () => {
  it.each(['IFC4', 'IFC4X3'])('%s namespace reaches builders and round trips results', async schema => {
    const parser = new IfcParser();
    const store = await parser.parseColumnar(new TextEncoder().encode(MODEL.replace('IFC2X3', schema)).buffer, { disableWorkerScan: true });
    const mutationView = new MutablePropertyView(null, 'model');
    const editor = new StoreEditor(store, mutationView);
    const backend = createStructuralStoreBackend(modelId => ({ modelId: modelId ?? 'model', store, editor, mutationView, ownerHistoryId: 4 }));
    const api = new CustomStoreNamespace({ store: backend } as unknown as BimBackend);
    api.addStructuralAnalysisModel('model', { Name: 'Frame' });
    api.addStructuralPlanarAction('model', { AppliedLoad: { Type: 'IfcStructuralLoadTemperature', DeltaTY: 2 } });
    api.addStructuralSurfaceAction('model', { AppliedLoad: { Type: 'IfcStructuralLoadPlanarForce', PlanarForceZ: -4 } });
    const reactions = [
      api.addStructuralPointReaction('model', { AppliedLoad: { Type: 'IfcStructuralLoadSingleDisplacement', DisplacementZ: 0.1 } }),
      api.addStructuralCurveReaction('model', { AppliedLoad: { LinearForceZ: 7 } }),
      api.addStructuralSurfaceReaction('model', { AppliedLoad: { PlanarForceZ: 8 } }),
    ];
    const group = api.addStructuralLoadGroup('model', { ActionType: 'PERMANENT_G', ActionSource: 'DEAD_LOAD_G' });
    api.addStructuralResultGroup('model', { TheoryType: 'FIRST_ORDER_THEORY', ResultForLoadGroup: group.expressId, IsLinear: true, ReactionIds: reactions.map(r => r.expressId) });
    const exported = new StepExporter(store, mutationView).export({ schema: schema as 'IFC4' | 'IFC4X3', applyMutations: true });
    const parsed = await parser.parseColumnar(exported.content instanceof Uint8Array ? exported.content.buffer as ArrayBuffer : new TextEncoder().encode(exported.content).buffer, { disableWorkerScan: true });
    const data = extractStructuralOnDemand(parsed);
    expect(data.analysisModels[0].name).toBe('Custom Frame');
    expect(data.activities.map(a => a.type)).toEqual(['IfcStructuralPlanarAction', 'IfcStructuralSurfaceAction', 'IfcStructuralPointReaction', 'IfcStructuralCurveReaction', 'IfcStructuralSurfaceReaction']);
    expect(data.resultGroups[0]).toMatchObject({ resultForLoadGroupGlobalId: data.loadGroups[0].globalId, activityGlobalIds: data.activities.slice(2).map(a => a.globalId) });
    expect(reactions.every(r => r.modelId === 'model')).toBe(true);
  });
  it('preserves the IFC4 fallback for undefined store schema (#9764, discussion_r4543272228)', async () => {
    const parser = new IfcParser();
    const store = await parser.parseColumnar(new TextEncoder().encode(MODEL.replace('IFC2X3', 'IFC4')).buffer, { disableWorkerScan: true });
    Reflect.deleteProperty(store, 'schemaVersion');
    const mutationView = new MutablePropertyView(null, 'model');
    const editor = new StoreEditor(store, mutationView);
    const api = createStructuralStoreBackend(() => ({ modelId: 'model', store, editor, mutationView, ownerHistoryId: 4 }));
    api.addStructuralPointAction('model', { ForceZ: 1 });
    api.addStructuralSurfaceAction('model', { AppliedLoad: { Type: 'IfcStructuralLoadPlanarForce', PlanarForceZ: 1 } });
    api.addStructuralCurveReaction('model', { AppliedLoad: { LinearForceZ: 1 } });
    api.addStructuralSurfaceReaction('model', { AppliedLoad: { PlanarForceZ: 1 } });
    const exported = new StepExporter(store, mutationView).export({ schema: 'IFC4', applyMutations: true });
    const bytes = exported.content instanceof Uint8Array ? exported.content.buffer as ArrayBuffer : new TextEncoder().encode(exported.content).buffer;
    const parsed = await parser.parseColumnar(bytes, { disableWorkerScan: true });
    expect(parsed.schemaVersion).toBe('IFC4');
    expect(extractStructuralOnDemand(parsed).activities.map(a => a.type)).toEqual([
      'IfcStructuralPointAction', 'IfcStructuralSurfaceAction', 'IfcStructuralCurveReaction', 'IfcStructuralSurfaceReaction',
    ]);
  });

  it('names each absent optional backend method', () => {
    const api = new StoreNamespace({ store: {} } as unknown as BimBackend);
    const load = { Type: 'IfcStructuralLoadPlanarForce' as const, PlanarForceZ: 1 };
    expect(() => api.addStructuralPlanarAction('m', { AppliedLoad: load })).toThrow('bim.store.addStructuralPlanarAction: not available on this backend');
    expect(() => api.addStructuralSurfaceAction('m', { AppliedLoad: load })).toThrow('bim.store.addStructuralSurfaceAction: not available on this backend');
    expect(() => api.addStructuralPointReaction('m', { AppliedLoad: { Type: 'IfcStructuralLoadSingleForce', ForceZ: 1 } })).toThrow('bim.store.addStructuralPointReaction: not available on this backend');
    expect(() => api.addStructuralCurveReaction('m', { AppliedLoad: {} })).toThrow('bim.store.addStructuralCurveReaction: not available on this backend');
    expect(() => api.addStructuralSurfaceReaction('m', { AppliedLoad: {} })).toThrow('bim.store.addStructuralSurfaceReaction: not available on this backend');
    expect(() => api.addStructuralResultGroup('m', { TheoryType: 'FIRST_ORDER_THEORY', ResultForLoadGroup: 1, IsLinear: true, ReactionIds: [2] })).toThrow('bim.store.addStructuralResultGroup: not available on this backend');
  });
});

// The generated Markdown is the output contract under review, not a source-code assertion.
it('general coverage ledger credits the structural builders (#9764, discussion_r4542889559)', () => {
  const root = new URL('../../../', import.meta.url);
  expect(() => execFileSync(process.execPath, [fileURLToPath(new URL('scripts/generate-coverage-ledger.mjs', root)), '--check'], {
    cwd: fileURLToPath(root), stdio: 'pipe',
  })).not.toThrow();
  const ledger = readFileSync(new URL('docs/architecture/coverage-ledger.md', root), 'utf8');
  for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3']) {
    const section = ledger.split(`## ${schema}\n`)[1]?.split('\n## ')[0] ?? '';
    const types = ['IfcStructuralPlanarAction', 'IfcStructuralPointReaction', 'IfcStructuralResultGroup',
      'IfcStructuralLoadPlanarForce', 'IfcStructuralLoadSingleDisplacement', 'IfcStructuralLoadTemperature',
      ...(schema === 'IFC2X3' ? [] : ['IfcStructuralSurfaceAction', 'IfcStructuralCurveReaction', 'IfcStructuralSurfaceReaction'])];
    for (const type of types) {
      // @source-text-assertion-ok generated Markdown output contract, not implementation source
      const row = section.split('\n').find(line => line.startsWith(`| ${type} |`));
      expect(row?.split('|')[6].trim(), `${schema}/${type} Creatable`).toBe('✅');
    }
  }
});
