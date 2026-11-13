/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * StructuralCard renders `extractStructuralOnDemand`'s read model for the
 * selected `IfcStructuralMember`. Asserted against the real fixture
 * (`structural_analysis_curve.ifc`, the corpus's only structural-analysis
 * export — see #4206) rather than a synthetic extraction, so a regression in
 * how the card reads the shared read model shows up here the same way it
 * would in the parser's own fixture test.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  StepTokenizer,
  ColumnarParser,
  extractStructuralOnDemand,
  ProjectUnits,
  type StructuralExtraction,
} from '@ifc-lite/parser';
import { StructuralCard } from './StructuralCard.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';

const FIXTURE = fileURLToPath(
  new URL('../../../../../../tests/models/ifcopenshell/structural_analysis_curve.ifc', import.meta.url),
);
const hasFixture = existsSync(FIXTURE);

async function parseFixture(): Promise<StructuralExtraction> {
  const source = new Uint8Array(readFileSync(FIXTURE));
  const tokenizer = new StepTokenizer(source);
  const entityRefs = Array.from(tokenizer.scanEntitiesFast()).map((ref) => ({
    expressId: ref.expressId,
    type: ref.type,
    byteOffset: ref.offset,
    byteLength: ref.length,
    lineNumber: ref.line,
  }));
  const parser = new ColumnarParser();
  const store = await parser.parseLite(source.buffer.slice(0) as ArrayBuffer, entityRefs, {});
  return extractStructuralOnDemand(store);
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(node: ReactElement): string {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
  return host.textContent ?? '';
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  setLocale('en');
});

const maybeIt = hasFixture ? it : it.skip;
const skipMsg = hasFixture ? '' : ' (fixture absent — run `pnpm fixtures`)';

describe(`StructuralCard against structural_analysis_curve.ifc${skipMsg}`, () => {
  maybeIt('renders the loaded member\'s analysis model, connections and the exact applied load', async () => {
    const data = await parseFixture();
    const action = data.activities.find((a) => a.kind === 'Action');
    assert.ok(action, 'expected the one applied action');
    const loaded = data.members.find((m) => m.activityGlobalIds.includes(action!.globalId));
    assert.ok(loaded, 'expected the member the action applies to');

    const text = render(
      <StructuralCard
        structuralData={data}
        selectedExpressId={loaded!.expressId}
        selectedGlobalId={loaded!.globalId}
      />,
    );

    assert.ok(text.includes('Structural Analysis #1'), `analysis model name in: ${text}`);
    // #327/#329: IFCSTRUCTURALLOADLINEARFORCE(.,$,$,-100.,$,$,$) at Locations
    // [96] and [192] — the pinned value from #4677's own evidence.
    assert.ok(text.includes('LinearForceZ: -100'), `LinearForceZ: -100 in: ${text}`);
    assert.ok(text.includes('96'), `location 96 in: ${text}`);
    assert.ok(text.includes('192'), `location 192 in: ${text}`);
    // Every member spans exactly two connections (continuous-beam fixture).
    assert.ok(text.includes('Connections (2)'), `connection count in: ${text}`);
    // loadsTruncated is false for this small, complete fixture.
    assert.ok(!text.includes('Truncated'), `no truncated badge in: ${text}`);
  });

  maybeIt('summarizes a fixed support as all six DOFs fixed, not as the number 1', async () => {
    const data = await parseFixture();
    const fixedConnection = data.connections.find((c) => c.appliedCondition !== undefined);
    assert.ok(fixedConnection, 'expected a connection with a boundary condition');
    const member = data.members.find((m) => m.connectionGlobalIds.includes(fixedConnection!.globalId));
    assert.ok(member, 'expected a member joined to the fixed connection');

    const text = render(
      <StructuralCard
        structuralData={data}
        selectedExpressId={member!.expressId}
        selectedGlobalId={member!.globalId}
      />,
    );
    assert.ok(text.includes('6 DOFs fixed') || text.includes('6/6 DOFs fixed'), `six fixed DOFs in: ${text}`);
    assert.ok(text.includes('Fixed'), `boundary condition name in: ${text}`);
  });

  maybeIt('distinguishes a truncated extraction from a complete one', async () => {
    const data = await parseFixture();
    const action = data.activities.find((a) => a.kind === 'Action')!;
    const loaded = data.members.find((m) => m.activityGlobalIds.includes(action.globalId))!;

    const complete = render(
      <StructuralCard structuralData={data} selectedExpressId={loaded.expressId} selectedGlobalId={loaded.globalId} />,
    );
    assert.ok(!complete.includes('Truncated'), `complete fixture shows no truncated badge: ${complete}`);

    const truncated: StructuralExtraction = { ...data, loadsTruncated: true };
    const truncatedText = render(
      <StructuralCard structuralData={truncated} selectedExpressId={loaded.expressId} selectedGlobalId={loaded.globalId} />,
    );
    assert.ok(truncatedText.includes('Truncated'), `truncated fixture shows the badge: ${truncatedText}`);
  });

  maybeIt('renders nothing when the selection is not a structural member', async () => {
    const data = await parseFixture();
    const text = render(
      <StructuralCard structuralData={data} selectedExpressId={999999} selectedGlobalId="not-a-real-globalid" />,
    );
    assert.equal(text, '');
  });

  maybeIt('renders nothing given a null extraction', () => {
    const text = render(<StructuralCard structuralData={null} selectedExpressId={1} selectedGlobalId="x" />);
    assert.equal(text, '');
  });
});

describe('StructuralCard synthetic boundary-condition invariants', () => {
  it('keeps direct IFC attribute labels canonical', () => {
    registerLocale('en-x-schema-label', {
      'properties.structural.thickness': '[translated thickness]',
      'properties.structural.predefined': '[translated predefined]',
    } as Catalogue);
    setLocale('en-x-schema-label');
    const data: StructuralExtraction = {
      analysisModels: [],
      members: [{ expressId: 10, globalId: 'member', type: 'IfcStructuralSurfaceMember', thickness: 0.25, predefinedType: 'SHELL',
        connectionGlobalIds: [], activityGlobalIds: [], analysisModelGlobalIds: [] }],
      connections: [], activities: [], loadGroups: [], resultGroups: [], hasStructural: true, loadsTruncated: false,
    };

    const text = render(<StructuralCard structuralData={data} selectedExpressId={10} selectedGlobalId="member" />);
    assert.ok(text.includes('Thickness'));
    assert.ok(text.includes('PredefinedType'));
    assert.ok(!text.includes('[translated thickness]'));
    assert.ok(!text.includes('[translated predefined]'));
  });

  it('reports numeric stiffness as elastic instead of fixed', () => {
    const data: StructuralExtraction = {
      analysisModels: [],
      members: [{
        expressId: 10,
        globalId: 'member',
        type: 'IfcStructuralCurveMember',
        connectionGlobalIds: ['connection'],
        activityGlobalIds: [],
        analysisModelGlobalIds: [],
      }],
      connections: [{
        expressId: 20,
        globalId: 'connection',
        type: 'IfcStructuralPointConnection',
        appliedCondition: {
          expressId: 30,
          type: 'IfcBoundaryNodeCondition',
          components: {
            TranslationalStiffnessX: true,
            TranslationalStiffnessY: false,
            TranslationalStiffnessZ: 1500,
          },
        },
        memberGlobalIds: ['member'],
        activityGlobalIds: [],
        analysisModelGlobalIds: [],
      }],
      activities: [],
      loadGroups: [],
      resultGroups: [],
      hasStructural: true,
      loadsTruncated: false,
    };

    const text = render(
      <StructuralCard structuralData={data} selectedExpressId={10} selectedGlobalId="member" />,
    );
    assert.ok(text.includes('1 DOF fixed'), `boolean true is fixed in: ${text}`);
    assert.ok(text.includes('1 DOF elastic'), `numeric stiffness is elastic in: ${text}`);
    assert.ok(text.includes('1 DOF free'), `boolean false is free in: ${text}`);
    assert.ok(!text.includes('3 DOFs fixed'), `numeric stiffness must not be called fixed in: ${text}`);
  });

  it('localizes DOF, component and configuration summaries as complete messages', () => {
    registerLocale('ar-EG', {
      'properties.structural.fixedDofs': '[fixed {countDisplay}]',
      'properties.structural.elasticDofs': '[elastic {countDisplay}]',
      'properties.structural.freeDofs': '[free {countDisplay}]',
      'properties.structural.noComponents': '[no components]',
      'properties.structural.componentValue': '[{name}={value}]',
      'properties.structural.configurationDropped': '[drop {name}]',
      'properties.structural.configurationAt': '[at {location}: {components}]',
    });
    setLocale('ar-EG');
    const data: StructuralExtraction = {
      analysisModels: [],
      members: [{ expressId: 10, globalId: 'member', type: 'IfcStructuralCurveMember',
        connectionGlobalIds: ['connection'], activityGlobalIds: ['empty', 'configured'], analysisModelGlobalIds: [] }],
      connections: [{ expressId: 20, globalId: 'connection', type: 'IfcStructuralPointConnection',
        appliedCondition: { expressId: 30, type: 'IfcBoundaryNodeCondition', components: {
          TranslationalStiffnessX: true, TranslationalStiffnessY: false, TranslationalStiffnessZ: 1500,
        } }, memberGlobalIds: ['member'], activityGlobalIds: [], analysisModelGlobalIds: [] }],
      activities: [
        { expressId: 40, globalId: 'empty', type: 'IfcStructuralCurveAction', kind: 'Action',
          appliedLoad: { expressId: 41, type: 'IfcStructuralLoadSingleForce', components: {} }, groupGlobalIds: [] },
        { expressId: 50, globalId: 'configured', type: 'IfcStructuralCurveAction', kind: 'Action',
          appliedLoad: { expressId: 51, type: 'IfcStructuralLoadConfiguration', components: {}, configuration: {
            entries: [
              { value: { expressId: 52, type: 'IfcStructuralLoadSingleForce', components: { ForceX: 1234.5 } }, location: [1.5] },
              { dropped: 'budget' },
            ], locations: [[1.5]], truncated: true,
          } }, groupGlobalIds: [] },
      ],
      loadGroups: [], resultGroups: [], hasStructural: true, loadsTruncated: true,
    };

    const text = render(<StructuralCard structuralData={data} selectedExpressId={10} selectedGlobalId="member" />);
    assert.match(text, /\[fixed ١\].*\[elastic ١\].*\[free ١\]/);
    assert.ok(text.includes('[no components]'));
    assert.ok(text.includes('Connections (١)'));
    assert.ok(text.includes('Applied loads (٢)'));
    assert.ok(text.includes('[at ١٫٥: [ForceX=١٬٢٣٤٫٥]]'));
    assert.ok(text.includes('[drop budget]'));
    assert.ok(!text.includes('DOF fixed'));
    assert.ok(!text.includes('[dropped:'));
  });
});

describe('StructuralCard for every structural record (#9668)', () => {
  const data: StructuralExtraction = {
    analysisModels: [{ expressId: 1, globalId: 'model', name: 'Frame', predefinedType: 'LOADING_3D',
      loadGroupGlobalIds: ['case'], resultGroupGlobalIds: [], itemGlobalIds: [] }],
    members: [],
    connections: [{ expressId: 20, globalId: 'support', type: 'IfcStructuralPointConnection', name: 'Pin',
      appliedCondition: { expressId: 21, type: 'IfcBoundaryNodeCondition', name: 'Hinge',
        components: { TranslationalStiffnessX: true, RotationalStiffnessY: 2500 } },
      memberGlobalIds: [], activityGlobalIds: [], analysisModelGlobalIds: [] }],
    activities: [{ expressId: 40, globalId: 'load', type: 'IfcStructuralPointAction', kind: 'Action', name: 'Snow',
      globalOrLocal: 'GLOBAL_COORDS', destabilizingLoad: false,
      appliedLoad: { expressId: 41, type: 'IfcStructuralLoadSingleForce', name: 'Point force', components: { ForceZ: -1000 } },
      groupGlobalIds: ['case'] }],
    loadGroups: [{ expressId: 50, globalId: 'case', type: 'IfcStructuralLoadCase', name: 'Snow case', predefinedType: 'LOAD_CASE',
      actionType: 'VARIABLE_Q', coefficient: 1.5, selfWeightCoefficients: [0, 0, -1], activityGlobalIds: ['load'] }],
    resultGroups: [], hasStructural: true, loadsTruncated: false,
  };
  const show = (expressId: number) => render(
    <StructuralCard structuralData={data} selectedExpressId={expressId} schemaVersion="IFC4" projectUnits={ProjectUnits.empty()} />,
  );

  it('shows an action\'s attributes and its applied load with the force unit', () => {
    const text = show(40);
    assert.ok(text.includes('PointAction'), `type badge in: ${text}`);
    assert.match(text, /GlobalOrLocalGLOBAL_COORDS/);
    assert.match(text, /DestabilizingLoadFALSE/);
    assert.match(text, /AppliedLoad#41/);
    assert.ok(text.includes('AppliedLoad · IfcStructuralLoadSingleForce #41'), `load section in: ${text}`);
    assert.match(text, /ForceZ-1,000 N/);
  });

  it('shows a connection\'s boundary condition, booleans and stiffness with its unit', () => {
    const text = show(20);
    assert.ok(text.includes('AppliedCondition · IfcBoundaryNodeCondition #21'), `condition section in: ${text}`);
    assert.match(text, /TranslationalStiffnessXTRUE/);
    assert.match(text, /RotationalStiffnessY2,500 N·m\/rad/);
  });

  it('shows a load case and an analysis model, naming the linked groups', () => {
    // A vector reads as its components, not as a sentence ("0, 0, and -1").
    assert.match(show(50), /ActionTypeVARIABLE_Q.*Coefficient1\.5SelfWeightCoefficients0, 0, -1$/);
    assert.match(show(1), /PredefinedTypeLOADING_3D.*LoadedBySnow case/);
  });

  it('keeps a small value\'s digits (#9668)', () => {
    const thin: StructuralExtraction = { ...data, members: [{ expressId: 10, globalId: 'plate', type: 'IfcStructuralSurfaceMember',
      thickness: 0.0125, connectionGlobalIds: [], activityGlobalIds: [], analysisModelGlobalIds: [] }] };
    const plate = render(<StructuralCard structuralData={thin} selectedExpressId={10} schemaVersion="IFC4" projectUnits={ProjectUnits.empty()} />);
    assert.match(plate, /Thickness0\.0125 m/);
  });

  it('applies the user\'s display unit, as the property cards do (#9668)', () => {
    const kn = render(<StructuralCard structuralData={data} selectedExpressId={40} schemaVersion="IFC4" projectUnits={ProjectUnits.empty()}
      unitDisplayOverrides={{ FORCEUNIT: 'kn' }} />);
    assert.match(kn, /ForceZ-1 kN/);
  });

  it('keeps each configuration slot in its place and says why one is empty (#9668)', () => {
    const configured: StructuralExtraction = { ...data, activities: [{ ...data.activities[0], appliedLoad: {
      expressId: 60, type: 'IfcStructuralLoadConfiguration', components: {}, configuration: {
        entries: [{ dropped: 'unresolved', location: [0] }, { value: { expressId: 61, type: 'IfcStructuralLoadLinearForce', components: { LinearForceZ: -2 } }, location: [4] }],
        locations: [[0], [4]], truncated: false } } }] };
    const text = render(<StructuralCard structuralData={configured} selectedExpressId={40} schemaVersion="IFC4" projectUnits={ProjectUnits.empty()} />);
    assert.match(text, /Values\[dropped: unresolved\], #61Locations\(0\), \(4\) m/);
    assert.ok(text.includes('Values[1] · IfcStructuralLoadLinearForce #61'), text);
  });

  it('renders a condition both ends of a member share without a duplicate React key (#9668)', () => {
    const hinge = { expressId: 21, type: 'IfcBoundaryNodeCondition', components: { TranslationalStiffnessX: true } };
    const shared: StructuralExtraction = { ...data, members: [{ expressId: 10, globalId: 'beam', type: 'IfcStructuralCurveMember',
      IfcRelConnectsStructuralMember: [{ expressId: 30, RelatedStructuralConnection: 20, AppliedCondition: hinge },
        { expressId: 31, RelatedStructuralConnection: 20, AppliedCondition: hinge }],
      connectionGlobalIds: [], activityGlobalIds: [], analysisModelGlobalIds: [] }] };
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const text = render(<StructuralCard structuralData={shared} selectedExpressId={10} schemaVersion="IFC4" projectUnits={ProjectUnits.empty()} />);
      assert.equal(text.split('AppliedCondition · IfcBoundaryNodeCondition #21').length - 1, 2, text);
    } finally {
      console.error = original;
    }
    assert.ok(!errors.some((args) => String(args[0]).includes('same key')), JSON.stringify(errors));
  });

  it('shows a member selected by a GlobalId it shares with another record (#9668)', () => {
    const shared: StructuralExtraction = { ...data, members: [{ expressId: 10, globalId: 'case', type: 'IfcStructuralCurveMember',
      predefinedType: 'CABLE', connectionGlobalIds: [], activityGlobalIds: [], analysisModelGlobalIds: [] }] };
    const text = render(<StructuralCard structuralData={shared} selectedExpressId={null} selectedGlobalId="case" schemaVersion="IFC4" />);
    assert.match(text, /StructuralCurveMember.*PredefinedTypeCABLE/);
  });

  it('omits an unset aggregate instead of showing an empty row (#9668)', () => {
    assert.doesNotMatch(show(1), /HasResults/);
  });

  it('prints no unit when the model\'s units cannot be read', () => {
    const text = render(<StructuralCard structuralData={data} selectedExpressId={40} schemaVersion="IFC4" projectUnits={null} />);
    assert.match(text, /ForceZ-1,000(?! N)/);
  });
});

